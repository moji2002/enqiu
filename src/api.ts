/**
 * `enqiu()` — a typed layer over BullMQ.
 *
 * Enqiu owns the developer experience: inferred job names, schema-validated
 * input, and one object you call like a function. BullMQ owns storage,
 * scheduling and execution. Anything BullMQ's open-source tier cannot express
 * is absent rather than faked, with two exceptions Enqiu enforces itself
 * around the handler because they cost nothing to add: `timeout` and
 * `expiresIn`.
 */

import {
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
  type Job as BullJob,
  type JobState,
  type JobsOptions,
  type QueueEventsListener,
  type RedisClient,
} from "bullmq";
import { assertJobValue } from "./serialize.js";
import {
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  JobValidationError,
  QueueClosedError,
  toError,
} from "./errors.js";
import { definitionMarker } from "./types.js";
import type {
  AnyJobSnapshot,
  BulkOptions,
  CleanupQuery,
  EnqiuOptions,
  JobCallable,
  JobContext,
  JobDefinition,
  JobDefinitions,
  JobHandle,
  JobHandler,
  JobListPage,
  JobListQuery,
  JobLogger,
  JobPolicyOptions,
  JobSnapshot,
  JobStatus,
  JobsApi,
  Progress,
  QueueApi,
  QueueEventMap,
  QueueStats,
  ScheduleHandle,
  ScheduleOptions,
  ScheduleSnapshot,
  SchemaJobDefinition,
  StandardSchemaV1,
  SubmitOptions,
  WorkerApi,
  WorkerStartOptions,
} from "./types.js";

const reservedNames = new Set(["queue", "worker", "bull"]);

/** Declare a job with a Standard Schema input and per-job policies. */
export function job<const Schema extends StandardSchemaV1, Output>(
  definition: Omit<SchemaJobDefinition<Schema, Output>, typeof definitionMarker>
): SchemaJobDefinition<Schema, Output> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("job() requires a definition object");
  }
  if (!isStandardSchema(definition.input)) {
    throw new TypeError("job.input must implement Standard Schema");
  }
  if (typeof definition.run !== "function") {
    throw new TypeError("job.run must be a function");
  }
  return Object.freeze({ ...definition, [definitionMarker]: true as const });
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!value || typeof value !== "object") return false;
  const standard = (value as Partial<StandardSchemaV1>)["~standard"];
  return (
    standard?.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

interface NormalizedDefinition {
  schema: StandardSchemaV1 | undefined;
  run: JobHandler;
  policy: JobPolicyOptions;
}

function normalizeDefinition(definition: JobDefinition): NormalizedDefinition {
  if (typeof definition === "function") {
    return { schema: undefined, run: definition as JobHandler, policy: {} };
  }
  if (
    !definition ||
    typeof definition !== "object" ||
    definition[definitionMarker] !== true
  ) {
    throw new TypeError(
      "Every job must be a handler or a definition created with job()"
    );
  }
  const policy: JobPolicyOptions = {};
  if (definition.retry !== undefined) policy.retry = definition.retry;
  if (definition.timeout !== undefined) policy.timeout = definition.timeout;
  if (definition.expiresIn !== undefined) {
    policy.expiresIn = definition.expiresIn;
  }
  return {
    schema: definition.input,
    run: definition.run as JobHandler,
    policy,
  };
}

async function validateInput(
  name: string,
  schema: StandardSchemaV1 | undefined,
  input: unknown
): Promise<unknown> {
  if (!schema) return input;
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new JobValidationError(name, result.issues);
  return result.value;
}

/**
 * Which BullMQ states make up each Enqiu status.
 *
 * One table drives every direction: reading a state back, listing and cleaning
 * by status, and summing stats. Keeping them as separate mappings let them
 * disagree — `stats()` counted a prioritized job as queued while `list()` did
 * not. `cancelled` is Enqiu's own, so it maps to nothing: BullMQ has no state
 * for it, and the marker hash is the only record.
 */
const bullStates = {
  queued: ["waiting", "prioritized"],
  scheduled: ["delayed"],
  running: ["active"],
  succeeded: ["completed"],
  failed: ["failed"],
  cancelled: [],
} as const satisfies Record<JobStatus, readonly JobState[]>;

const everyState: readonly JobState[] = Object.values(bullStates).flat();

const statusByState = new Map<string, JobStatus>(
  Object.entries(bullStates).flatMap(([status, states]) =>
    states.map((state) => [state, status as JobStatus] as const)
  )
);

/** BullMQ's states, mapped onto Enqiu's vocabulary. */
function toStatus(state: string): JobStatus {
  return statusByState.get(state) ?? "queued";
}

function toSnapshot(bull: BullJob, status: JobStatus): JobSnapshot {
  const snapshot: JobSnapshot = {
    id: String(bull.id),
    name: bull.name,
    input: bull.data,
    status,
    attempt: bull.attemptsMade,
    createdAt: bull.timestamp,
  };
  if (bull.processedOn) snapshot.startedAt = bull.processedOn;
  if (bull.finishedOn) snapshot.finishedAt = bull.finishedOn;
  if (bull.progress !== undefined && bull.progress !== 0) {
    snapshot.progress = bull.progress;
  }
  if (bull.returnvalue !== undefined && bull.returnvalue !== null) {
    snapshot.output = bull.returnvalue;
  }
  if (bull.failedReason) {
    snapshot.error = { name: "Error", message: bull.failedReason };
  }
  return snapshot;
}

// BullMQ orders ascending: a lower number runs sooner.
const priorities = { high: 1, normal: 2, low: 3 };

/** For handlers with no deadline, whose only abort source is BullMQ's own. */
const neverAborts = new AbortController().signal;

/**
 * Enqiu's events, and the BullMQ event that carries each.
 *
 * `state` is what the event itself proves about the job, which saves asking
 * Redis for a state the notification already carried — and is the more
 * faithful answer besides, since a subscriber wants the state at the time of
 * the event rather than whatever it has become since. `added` proves only that
 * the job exists, not whether it was delayed or prioritized.
 */
const queueEventMap = {
  added: { name: "added", state: undefined },
  started: { name: "active", state: "active" },
  progress: { name: "progress", state: "active" },
  succeeded: { name: "completed", state: "completed" },
  failed: { name: "failed", state: "failed" },
  error: { name: "error", state: undefined },
} as const satisfies Record<
  keyof QueueEventMap,
  { name: keyof QueueEventsListener; state: JobState | undefined }
>;

function validateProgress(progress: Progress): void {
  if (
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    progress.completed < 0 ||
    progress.total <= 0 ||
    progress.completed > progress.total
  ) {
    throw new RangeError(
      "Progress requires 0 <= completed <= total and total > 0"
    );
  }
}

class PublicJobHandle<Output, Input, Name extends string>
  implements JobHandle<Output, Input, Name>
{
  private known: JobStatus;
  private resultPromise: Promise<Output> | undefined;

  constructor(
    private readonly bull: BullJob,
    private readonly facade: Facade,
    readonly deduplicated: boolean,
    status: JobStatus
  ) {
    this.known = status;
  }

  get id(): string {
    return String(this.bull.id);
  }

  get name(): Name {
    return this.bull.name as Name;
  }

  get input(): Input {
    return this.bull.data as Input;
  }

  get status(): JobStatus {
    return this.known;
  }

  get result(): Promise<Output> {
    this.resultPromise ??= this.facade.awaitResult(this.bull) as Promise<Output>;
    return this.resultPromise;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.facade.cancelJob(this.bull, reason ?? "Job was cancelled");
  }

  async refresh(): Promise<JobSnapshot<Input, Output, Name>> {
    const snapshot = await this.facade.snapshotOf(this.id);
    if (!snapshot) throw new Error(`Job "${this.id}" no longer exists`);
    this.known = snapshot.status;
    return snapshot as JobSnapshot<Input, Output, Name>;
  }
}

/**
 * BullMQ's own Redis client, plus the one command it does not declare.
 *
 * Reaching into the backend is a private detail either way, but going through
 * `RedisClient` rather than an ioredis-shaped interface keeps this working on
 * every client BullMQ adapts — node-redis and Bun included, where `hset` takes
 * a field map instead of positional arguments. XREVRANGE is genuinely absent:
 * nothing in BullMQ reads a stream backwards.
 */
type BackendClient = RedisClient & {
  xrevrange(
    key: string,
    end: string,
    start: string,
    count: string,
    limit: string
  ): Promise<unknown>;
};

/** The parts of the facade a handle needs, without its generic parameter. */
interface Facade {
  awaitResult(bull: BullJob): Promise<unknown>;
  cancelJob(bull: BullJob, reason: string): Promise<boolean>;
  snapshotOf(id: string): Promise<JobSnapshot | undefined>;
}

class EnqiuFacade<Definitions extends JobDefinitions> implements Facade {
  readonly api: JobsApi<Definitions>;

  private readonly definitions = new Map<string, NormalizedDefinition>();
  private readonly queue: Queue;
  private readonly queueName: string;
  private readonly logLimit: number;
  private readonly check: <T>(value: T) => T;
  private readonly base: { connection: EnqiuOptions["connection"]; prefix?: string };
  private readonly cancelledKey: string;
  private worker: Worker | undefined;
  private events: Promise<QueueEvents> | undefined;

  constructor(
    definitions: Definitions,
    private readonly options: EnqiuOptions
  ) {
    for (const [name, definition] of Object.entries(definitions)) {
      if (reservedNames.has(name)) {
        throw new TypeError(`"${name}" is reserved by enqiu`);
      }
      this.definitions.set(name, normalizeDefinition(definition));
    }
    if (this.definitions.size === 0) {
      throw new TypeError("At least one job definition is required");
    }
    if (!options.connection) {
      throw new TypeError("enqiu() requires a BullMQ connection");
    }

    this.queueName = options.name ?? "default";
    this.logLimit = options.logLimit ?? 100;
    this.check =
      options.validatePayloads === false ? (value) => value : assertJobValue;
    this.base = {
      connection: options.connection,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.queue = new Queue(this.queueName, this.base);
    this.cancelledKey = this.queue.toKey("enqiu:cancelled");

    if (options.worker !== false) {
      const { concurrency, autoStart = true } = options.worker ?? {};
      this.worker = new Worker(
        this.queueName,
        // Three parameters on purpose: BullMQ decides whether to create an
        // AbortController by reading `processor.length >= 3`. Declaring fewer
        // means worker.cancelJob() can never abort anything.
        async (bull: BullJob, _token?: string, signal?: AbortSignal) =>
          this.process(bull, signal),
        {
          ...this.base,
          ...(concurrency === undefined ? {} : { concurrency }),
          autorun: false,
        }
      );
      if (autoStart) void this.worker.run();
    }

    const target: Record<PropertyKey, unknown> = {};
    for (const [name, definition] of this.definitions) {
      target[name] = this.createCallable(name, definition);
    }
    target.queue = this.createQueueApi();
    target.worker = this.createWorkerApi();
    target.bull = Object.freeze({ queue: this.queue, worker: this.worker });
    this.api = Object.freeze(target) as JobsApi<Definitions>;
  }

  /**
   * Read from BullMQ rather than mirrored here.
   *
   * A caller holding `jobs.bull.queue` can close it, and one holding
   * `jobs.bull.worker` can pause it; a flag maintained alongside would go on
   * claiming otherwise. BullMQ sets both synchronously, so this is as prompt
   * as the flag was.
   */
  private get closed(): boolean {
    return this.queue.closing !== undefined;
  }

  private get workerRunning(): boolean {
    return (
      this.worker !== undefined &&
      this.worker.isRunning() &&
      !this.worker.isPaused()
    );
  }

  /** Options BullMQ can carry across the queue, resolved submit → job → queue. */
  private toJobsOptions(
    options: SubmitOptions,
    policy: JobPolicyOptions
  ): JobsOptions {
    const jobsOptions: JobsOptions = { keepLogs: this.logLimit };

    if (options.id !== undefined) jobsOptions.jobId = options.id;
    if (options.delay !== undefined) {
      jobsOptions.delay =
        options.delay instanceof Date
          ? Math.max(0, options.delay.getTime() - Date.now())
          : options.delay;
    }
    if (options.priority !== undefined) {
      jobsOptions.priority =
        typeof options.priority === "string"
          ? priorities[options.priority]
          : options.priority;
    }
    if (options.idempotencyKey !== undefined) {
      jobsOptions.deduplication = { id: options.idempotencyKey };
      if (options.idempotencyTtl !== undefined) {
        jobsOptions.deduplication.ttl = options.idempotencyTtl;
      }
    }

    const retry = options.retry ?? policy.retry ?? this.options.retry;
    if (retry !== undefined) {
      const attempts = typeof retry === "number" ? retry + 1 : retry.attempts;
      if (!Number.isInteger(attempts) || attempts < 1) {
        throw new RangeError("retry.attempts must be a positive integer");
      }
      jobsOptions.attempts = attempts;
      const backoff = typeof retry === "number" ? undefined : retry.backoff;
      if (backoff !== undefined) {
        jobsOptions.backoff =
          typeof backoff === "number"
            ? backoff
            : { type: backoff.type ?? "fixed", delay: backoff.delay };
      }
    }
    return jobsOptions;
  }

  private createContext(bull: BullJob, signal: AbortSignal): JobContext {
    const queue = this.queueName;
    const telemetry = this.options.telemetry;
    const write = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ): void => {
      if (!message) throw new TypeError("Job log messages must not be empty");
      void bull
        .log(JSON.stringify({ level, message, fields, at: Date.now() }))
        .catch(() => undefined);
      telemetry?.emit({
        type: `job.log.${level}`,
        queue,
        timestamp: Date.now(),
        fields: { jobId: String(bull.id), jobName: bull.name, message },
      });
    };
    const log: JobLogger = {
      debug: (m, f) => write("debug", m, f),
      info: (m, f) => write("info", m, f),
      warn: (m, f) => write("warn", m, f),
      error: (m, f) => write("error", m, f),
    };

    return {
      id: String(bull.id),
      name: bull.name,
      attempt: bull.attemptsMade + 1,
      signal,
      log,
      reportProgress: async (progress: Progress) => {
        validateProgress(progress);
        await bull.updateProgress(this.check(progress) as never);
        telemetry?.emit({
          type: "job.progress",
          queue,
          timestamp: Date.now(),
          fields: { jobId: String(bull.id), progress },
        });
      },
    };
  }

  /** Runs one job: expiry, deadline, and the handler's context. */
  private async process(
    bull: BullJob,
    external?: AbortSignal
  ): Promise<unknown> {
    const definition = this.definitions.get(bull.name);
    if (!definition) {
      throw new UnrecoverableError(
        `No handler registered for job "${bull.name}"`
      );
    }

    const { expiresIn } = definition.policy;
    if (expiresIn !== undefined && Date.now() - bull.timestamp > expiresIn) {
      // Expiry is a property of the job, not of this attempt, so retrying
      // cannot help — UnrecoverableError stops BullMQ retrying it.
      throw new UnrecoverableError(new JobExpiredError(String(bull.id)).message);
    }

    const timeout = definition.policy.timeout ?? this.options.timeout;
    if (timeout === undefined) {
      // BullMQ's signal already aborts on cancellation, and with no deadline to
      // merge in there is nothing left for a second controller to do.
      const context = this.createContext(bull, external ?? neverAborts);
      return this.check(await definition.run(bull.data, context));
    }

    // One signal for the handler, whichever reason fires first: this queue's
    // own timeout, or a cancellation delivered through BullMQ.
    const controller = new AbortController();
    if (external) {
      if (external.aborted) {
        controller.abort(external.reason);
      } else {
        external.addEventListener(
          "abort",
          () => controller.abort(external.reason),
          { once: true }
        );
      }
    }
    const execution = Promise.resolve(
      definition.run(bull.data, this.createContext(bull, controller.signal))
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return this.check(
        await Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const error = new JobTimeoutError(String(bull.id), timeout);
              controller.abort(error);
              reject(error);
            }, timeout);
          }),
        ])
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new QueueClosedError(this.queueName);
  }

  /**
   * Lazily opened, and opened from a known point in the stream.
   *
   * BullMQ's QueueEvents defaults to reading from the present, which it
   * evaluates when its read loop starts rather than when it is constructed.
   * A caller that subscribed and immediately submitted could therefore miss
   * its own `added` event. Capturing the stream tail first and passing it as
   * `lastEventId` closes that window: nothing appended after this point can
   * fall between the two.
   */
  private queueEvents(): Promise<QueueEvents> {
    this.events ??= (async () => {
      const client = await this.markers();
      const tail = await client.xrevrange(
        this.queue.toKey("events"),
        "+",
        "-",
        "COUNT",
        "1"
      );
      const first = Array.isArray(tail) ? (tail[0] as unknown[]) : undefined;
      const lastEventId = first ? String(first[0]) : "0-0";
      const events = new QueueEvents(this.queueName, {
        ...this.base,
        lastEventId,
      });
      await events.waitUntilReady();
      return events;
    })();
    return this.events;
  }

  async awaitResult(bull: BullJob): Promise<unknown> {
    const id = String(bull.id);
    try {
      return await bull.waitUntilFinished(await this.queueEvents());
    } catch (cause) {
      if (await this.readCancelled(id)) throw new JobCancelledError(id);
      const error = toError(cause);
      if (error.message.includes("timed out after")) throw error;
      if (error.message.includes("expired before it could start")) {
        throw new JobExpiredError(id);
      }
      throw new JobFailedError(id, error.message, { cause: error });
    }
  }

  /**
   * Where cancellations are recorded.
   *
   * Cancelling removes the job, so without a marker the only evidence is gone
   * and `refresh()` cannot tell "cancelled" from "never existed". Keeping that
   * in a process-local Set made the answer depend on which process asked, and
   * lose it entirely on restart.
   */
  private async markers(): Promise<BackendClient> {
    return (await this.queue.getBackend().client) as BackendClient;
  }

  async cancelJob(bull: BullJob, reason: string): Promise<boolean> {
    const id = String(bull.id);
    const state = await bull.getState();
    if (state === "completed" || state === "failed" || state === "unknown") {
      return false;
    }

    if (state === "active") {
      // A running job cannot be removed, but this process's worker can abort
      // it if it is the one holding it. Another worker's job is not ours to
      // cancel, and BullMQ offers no cross-process signal for that.
      if (!this.worker?.cancelJob(id, reason)) return false;
    } else {
      try {
        await bull.remove();
      } catch {
        return false;
      }
    }

    const client = await this.markers();
    await client.hset(this.cancelledKey, {
      [id]: JSON.stringify({ reason, at: Date.now() }),
    });
    this.options.telemetry?.emit({
      type: "job.cancelled",
      queue: this.queueName,
      timestamp: Date.now(),
      fields: { jobId: id, reason },
    });
    return true;
  }

  private async readCancelled(
    id: string
  ): Promise<{ reason: string; at: number } | undefined> {
    const client = await this.markers();
    const raw = await client.hget(this.cancelledKey, id);
    return raw ? (JSON.parse(raw) as { reason: string; at: number }) : undefined;
  }

  /** Markers outlive their jobs otherwise, so the hash grows forever. */
  private async pruneMarkers(threshold: number): Promise<void> {
    const client = await this.markers();
    const stale = Object.entries(await client.hgetall(this.cancelledKey))
      .filter(([, raw]) => {
        try {
          return (JSON.parse(raw) as { at: number }).at <= threshold;
        } catch {
          return true;
        }
      })
      .map(([id]) => id);
    // In batches: one HDEL naming every stale field can exceed Redis' limit
    // on arguments per command.
    for (let from = 0; from < stale.length; from += 500) {
      await client.hdel(this.cancelledKey, ...stale.slice(from, from + 500));
    }
  }

  /** `state` skips a round trip when the caller already knows it. */
  async snapshotOf(id: string, state?: JobState): Promise<JobSnapshot | undefined> {
    const bull = await this.queue.getJob(id);
    if (!bull) {
      const cancelled = await this.readCancelled(id);
      if (!cancelled) return undefined;
      // The job itself is gone, so its final state lives in the marker.
      return {
        id,
        name: "unknown",
        input: undefined,
        status: "cancelled",
        attempt: 0,
        createdAt: cancelled.at,
        finishedAt: cancelled.at,
        error: { name: "JobCancelledError", message: cancelled.reason },
      };
    }

    const settled = state ?? (await bull.getState());
    // An aborted job settles as failed; the marker is what distinguishes a
    // deliberate cancellation from one that simply threw.
    if (settled === "failed" && (await this.readCancelled(id))) {
      return toSnapshot(bull, "cancelled");
    }
    return toSnapshot(bull, toStatus(settled));
  }

  /**
   * Submissions wait on a subscription that is still opening, so a caller that
   * subscribed and immediately submitted cannot miss its own `added` event.
   */
  private async ready(): Promise<void> {
    this.assertOpen();
    if (this.events) await this.events;
  }

  private createCallable(
    name: string,
    definition: NormalizedDefinition
  ): JobCallable<unknown, unknown, unknown, string, StandardSchemaV1 | undefined> {
    const submit = async (
      input: unknown,
      options: SubmitOptions = {}
    ): Promise<JobHandle> => {
      await this.ready();
      const value = this.check(
        await validateInput(name, definition.schema, input)
      );
      // Ask before adding: on a hit BullMQ returns the *existing* job, so
      // afterwards its id is the deduplication owner and the two are
      // indistinguishable.
      let deduplicated = false;
      if (options.idempotencyKey !== undefined) {
        const owner = await this.queue.getDeduplicationJobId(
          options.idempotencyKey
        );
        deduplicated = owner !== undefined && owner !== null;
      }
      const bull = await this.queue.add(
        name,
        value,
        this.toJobsOptions(options, definition.policy)
      );
      return new PublicJobHandle(
        bull,
        this,
        deduplicated,
        options.delay === undefined ? "queued" : "scheduled"
      );
    };

    const bulk = async (
      inputs: readonly unknown[],
      options: BulkOptions = {}
    ): Promise<JobHandle[]> => {
      if (options.ids && options.ids.length !== inputs.length) {
        throw new RangeError("bulk ids must match the number of inputs");
      }
      await this.ready();
      const values = await Promise.all(
        inputs.map(async (input) =>
          this.check(await validateInput(name, definition.schema, input))
        )
      );
      // Only the id varies across the batch, so the rest is resolved once.
      const shared = this.toJobsOptions(options, definition.policy);
      const created = await this.queue.addBulk(
        values.map((data, index) => {
          const id = options.ids?.[index];
          return {
            name,
            data,
            opts: id === undefined ? shared : { ...shared, jobId: id },
          };
        })
      );
      return created.map(
        (bull) =>
          new PublicJobHandle(
            bull,
            this,
            false,
            options.delay === undefined ? "queued" : "scheduled"
          )
      );
    };

    const schedule = async (
      options: ScheduleOptions<unknown>
    ): Promise<ScheduleHandle> => {
      this.assertOpen();
      const value = this.check(
        await validateInput(name, definition.schema, options.input)
      );
      const id = options.id?.trim() || name;
      await this.queue.upsertJobScheduler(
        id,
        {
          pattern: options.cron,
          ...(options.timezone === undefined ? {} : { tz: options.timezone }),
        },
        { name, data: value }
      );
      return this.scheduleHandle(id, name);
    };

    return Object.assign(submit, {
      bulk,
      schedule,
      input: definition.schema,
    }) as unknown as JobCallable<
      unknown,
      unknown,
      unknown,
      string,
      StandardSchemaV1 | undefined
    >;
  }

  private scheduleHandle(id: string, jobName: string): ScheduleHandle {
    const queue = this.queue;
    return {
      id,
      remove: async () => {
        await queue.removeJobScheduler(id);
      },
      refresh: async (): Promise<ScheduleSnapshot> => {
        const scheduler = await queue.getJobScheduler(id);
        if (!scheduler) throw new Error(`Schedule "${id}" does not exist`);
        return {
          id,
          jobName,
          cron: String(scheduler.pattern ?? ""),
          timezone: String(scheduler.tz ?? "UTC"),
          nextRunAt: Number(scheduler.next ?? 0),
          input: scheduler.template?.data,
        };
      },
    };
  }

  private createQueueApi(): QueueApi<Definitions> {
    return Object.freeze({
      get: async (id: string) =>
        (await this.snapshotOf(id)) as AnyJobSnapshot<Definitions> | undefined,

      list: async (query: JobListQuery = {}) => {
        const limit = query.limit ?? 100;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          throw new RangeError(
            "list.limit must be an integer between 1 and 1000"
          );
        }
        const offset =
          query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
        if (!Number.isInteger(offset) || offset < 0) {
          throw new TypeError("Invalid list cursor");
        }
        const status = query.status;
        const types = status ? bullStates[status] : everyState;
        const page: JobListPage<AnyJobSnapshot<Definitions>> = { jobs: [] };
        // "cancelled" has no BullMQ state, so there is nothing to ask for.
        if (types.length === 0) return page;

        const bulls = await this.queue.getJobs(
          [...types],
          offset,
          offset + limit - 1
        );
        // Filtering by status already fixes what every job in the page is;
        // asking Redis again would be one round trip per job for no answer.
        page.jobs = (status
          ? bulls.map((bull) => toSnapshot(bull, status))
          : await Promise.all(
              bulls.map(async (bull) =>
                toSnapshot(bull, toStatus(await bull.getState()))
              )
            )) as AnyJobSnapshot<Definitions>[];
        if (page.jobs.length === limit) page.cursor = String(offset + limit);
        return page;
      },

      stats: async (): Promise<QueueStats> => {
        const counts = await this.queue.getJobCounts(...everyState);
        const sum = (status: JobStatus): number =>
          bullStates[status].reduce((n, state) => n + (counts[state] ?? 0), 0);
        const stats = {
          queued: sum("queued"),
          scheduled: sum("scheduled"),
          running: sum("running"),
          succeeded: sum("succeeded"),
          failed: sum("failed"),
        };
        return {
          ...stats,
          total: Object.values(stats).reduce((a, b) => a + b, 0),
        };
      },

      pause: () => this.queue.pause(),
      resume: () => this.queue.resume(),

      setConcurrency: async (limit: number) => {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new RangeError("concurrency must be a positive integer");
        }
        await this.queue.setGlobalConcurrency(limit);
      },

      redrive: async (id: string) => {
        const bull = await this.queue.getJob(id);
        if (!bull) throw new Error(`Job "${id}" cannot be redriven`);
        const state = await bull.getState();
        if (state !== "failed" && state !== "completed") {
          throw new Error(`Job "${id}" cannot be redriven`);
        }
        await bull.retry(state);
        return new PublicJobHandle(bull, this, false, "queued");
      },

      cleanup: async (query: CleanupQuery = {}) => {
        const olderThan = query.olderThan ?? 0;
        if (!Number.isFinite(olderThan) || olderThan < 0) {
          throw new RangeError("olderThan must be a non-negative finite number");
        }
        // One clean type per call is BullMQ's limit, so a status backed by
        // several states cleans its first. "cancelled" is markers only.
        const type = query.status ? bullStates[query.status][0] : "completed";
        const removed = type
          ? await this.queue.clean(olderThan, query.limit ?? 1000, type)
          : [];
        await this.pruneMarkers(Date.now() - olderThan);
        return removed;
      },

      on: <Event extends keyof QueueEventMap>(
        event: Event,
        listener: (payload: QueueEventMap[Event]) => void
      ) => {
        const { name, state } = queueEventMap[event];
        const handler = (payload: { jobId?: string }): void => {
          if (event === "error") {
            listener(payload as never);
            return;
          }
          // The event name already says what state the job is in, so only the
          // job itself has to be fetched.
          void this.snapshotOf(String(payload.jobId), state).then((snapshot) => {
            if (snapshot) listener(snapshot as never);
          });
        };
        // Attaching has to wait for the stream to open, so unsubscribing
        // before that has to be remembered rather than applied.
        let detach: (() => void) | undefined;
        let unsubscribed = false;
        void this.queueEvents().then((events) => {
          if (unsubscribed) return;
          events.on(name, handler as never);
          detach = () => events.off(name, handler as never);
        });
        return () => {
          unsubscribed = true;
          detach?.();
        };
      },
    } satisfies QueueApi<Definitions>);
  }

  private createWorkerApi(): WorkerApi {
    const facade = this;
    return Object.freeze({
      get running() {
        return facade.workerRunning;
      },
      start: async (options: WorkerStartOptions = {}) => {
        if (!facade.worker) {
          throw new TypeError(
            "This queue was created with worker: false and cannot run jobs"
          );
        }
        if (options.concurrency !== undefined) {
          facade.worker.concurrency = options.concurrency;
        }
        if (facade.worker.isPaused()) facade.worker.resume();
        if (!facade.worker.isRunning()) void facade.worker.run();
      },
      pause: async () => {
        await facade.worker?.pause();
      },
      resume: async () => {
        facade.worker?.resume();
      },
      onIdle: async () => {
        // BullMQ has no idle signal, so poll the counts it already maintains
        // rather than tracking the same state in parallel. The wait widens so
        // that draining a long queue does not sit at 50 polls a second.
        for (let wait = 20; ; wait = Math.min(wait * 2, 250)) {
          const outstanding = await facade.queue.getJobCountByTypes(
            "waiting",
            "active",
            "delayed",
            "prioritized"
          );
          if (outstanding === 0) return;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      },
      close: async (options?: { drain?: boolean }) => {
        if ((options?.drain ?? true) && facade.workerRunning) {
          await facade.api.worker.onIdle();
        }
        // Three independent connections: closing the worker waits out the
        // jobs it holds, which the other two have no reason to wait for.
        const events = await facade.events;
        await Promise.all([
          facade.worker?.close(),
          events?.close(),
          facade.queue.close(),
        ]);
      },
    } satisfies WorkerApi);
  }
}

/** Build a typed job API backed by a BullMQ queue. */
export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options: EnqiuOptions
): JobsApi<Definitions> {
  return new EnqiuFacade(definitions, options).api;
}
