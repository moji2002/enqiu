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
  type JobsOptions,
} from "bullmq";
import { assertJobValue } from "./codec.js";
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
  Telemetry,
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

/** BullMQ's states, mapped onto Enqiu's vocabulary. */
function toStatus(state: string): JobStatus {
  if (state === "completed") return "succeeded";
  if (state === "failed") return "failed";
  if (state === "active") return "running";
  if (state === "delayed") return "scheduled";
  return "queued";
}

function bullTypeFor(status: JobStatus): string {
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "active";
  if (status === "scheduled") return "delayed";
  return "waiting";
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

function toJobsOptions(
  options: SubmitOptions,
  policy: JobPolicyOptions,
  logLimit: number
): JobsOptions {
  const jobsOptions: JobsOptions = { keepLogs: logLimit };

  if (options.id !== undefined) jobsOptions.jobId = options.id;
  if (options.delay !== undefined) {
    jobsOptions.delay =
      options.delay instanceof Date
        ? Math.max(0, options.delay.getTime() - Date.now())
        : options.delay;
  }
  if (options.priority !== undefined) {
    // BullMQ orders ascending: a lower number runs sooner.
    jobsOptions.priority =
      typeof options.priority === "string"
        ? { high: 1, normal: 2, low: 3 }[options.priority]
        : options.priority;
  }
  if (options.idempotencyKey !== undefined) {
    jobsOptions.deduplication = { id: options.idempotencyKey };
    if (options.idempotencyTtl !== undefined) {
      jobsOptions.deduplication.ttl = options.idempotencyTtl;
    }
  }

  const retry = options.retry ?? policy.retry;
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

function createContext(
  bull: BullJob,
  signal: AbortSignal,
  queue: string,
  telemetry: Telemetry | undefined
): JobContext {
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
  const log: JobLogger = Object.freeze({
    debug: (m: string, f?: Readonly<Record<string, unknown>>) =>
      write("debug", m, f),
    info: (m: string, f?: Readonly<Record<string, unknown>>) =>
      write("info", m, f),
    warn: (m: string, f?: Readonly<Record<string, unknown>>) =>
      write("warn", m, f),
    error: (m: string, f?: Readonly<Record<string, unknown>>) =>
      write("error", m, f),
  });

  return {
    id: String(bull.id),
    name: bull.name,
    attempt: bull.attemptsMade + 1,
    signal,
    log,
    reportProgress: async (progress: Progress) => {
      validateProgress(progress);
      await bull.updateProgress(assertJobValue(progress) as never);
      telemetry?.emit({
        type: "job.progress",
        queue,
        timestamp: Date.now(),
        fields: { jobId: String(bull.id), progress },
      });
    },
  };
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
 * The slice of the Redis client the cancellation marker needs.
 *
 * Narrow on purpose: reaching into BullMQ's backend is a private detail, and
 * naming exactly four commands keeps that coupling visible and small.
 */
interface MarkerStore {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<unknown>;
  xrevrange(
    key: string,
    end: string,
    start: string,
    count: string,
    limit: string
  ): Promise<unknown>;
}

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
  private readonly cancelled = new Set<string>();
  private worker: Worker | undefined;
  private events: Promise<QueueEvents> | undefined;
  private workerRunning = false;
  private closed = false;

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
    this.queue = new Queue(this.queueName, this.bullBase());

    const workerOptions =
      options.worker === false ? undefined : options.worker ?? {};
    if (workerOptions) {
      this.worker = new Worker(
        this.queueName,
        // Three parameters on purpose: BullMQ decides whether to create an
        // AbortController by reading `processor.length >= 3`. Declaring fewer
        // means worker.cancelJob() can never abort anything.
        async (bull: BullJob, _token?: string, signal?: AbortSignal) =>
          this.process(bull, signal),
        {
          ...this.bullBase(),
          ...(workerOptions.concurrency === undefined
            ? {}
            : { concurrency: workerOptions.concurrency }),
          autorun: false,
        }
      );
      if (workerOptions.autoStart ?? true) {
        this.workerRunning = true;
        void this.worker.run();
      }
    }

    const target: Record<PropertyKey, unknown> = {};
    for (const name of this.definitions.keys()) {
      target[name] = this.createCallable(name);
    }
    target.queue = this.createQueueApi();
    target.worker = this.createWorkerApi();
    target.bull = Object.freeze({ queue: this.queue, worker: this.worker });
    this.api = Object.freeze(target) as JobsApi<Definitions>;
  }

  private bullBase(): { connection: EnqiuOptions["connection"]; prefix?: string } {
    return {
      connection: this.options.connection,
      ...(this.options.prefix === undefined
        ? {}
        : { prefix: this.options.prefix }),
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
    const context = createContext(
      bull,
      controller.signal,
      this.queueName,
      this.options.telemetry
    );
    const timeout = definition.policy.timeout ?? this.options.timeout;
    const execution = Promise.resolve(definition.run(bull.data, context));

    if (timeout === undefined) {
      return this.check(await execution);
    }

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
        ...this.bullBase(),
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
      if (this.cancelled.has(id) || (await this.readCancelled(id))) {
        throw new JobCancelledError(id);
      }
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
  private async markers(): Promise<MarkerStore> {
    return (await this.queue.getBackend().client) as unknown as MarkerStore;
  }

  private cancelledKey(): string {
    return this.queue.toKey("enqiu:cancelled");
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
      await this.markCancelled(id, reason);
      this.emitCancelled(id, reason);
      return true;
    }

    try {
      await bull.remove();
    } catch {
      return false;
    }
    await this.markCancelled(id, reason);
    this.emitCancelled(id, reason);
    return true;
  }

  private async markCancelled(id: string, reason: string): Promise<void> {
    this.cancelled.add(id);
    const client = await this.markers();
    await client.hset(
      this.cancelledKey(),
      id,
      JSON.stringify({ reason, at: Date.now() })
    );
  }

  private async readCancelled(
    id: string
  ): Promise<{ reason: string; at: number } | undefined> {
    const client = await this.markers();
    const raw = await client.hget(this.cancelledKey(), id);
    return raw ? (JSON.parse(raw) as { reason: string; at: number }) : undefined;
  }

  private emitCancelled(id: string, reason: string): void {
    this.options.telemetry?.emit({
      type: "job.cancelled",
      queue: this.queueName,
      timestamp: Date.now(),
      fields: { jobId: id, reason },
    });
  }

  async snapshotOf(id: string): Promise<JobSnapshot | undefined> {
    const bull = await this.queue.getJob(id);
    if (bull) {
      const state = await bull.getState();
      // An aborted job settles as failed; the marker is what distinguishes a
      // deliberate cancellation from one that simply threw.
      if (state === "failed" && (await this.readCancelled(id))) {
        return toSnapshot(bull, "cancelled");
      }
      return toSnapshot(bull, toStatus(state));
    }
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

  private createCallable(
    name: string
  ): JobCallable<unknown, unknown, unknown, string, StandardSchemaV1 | undefined> {
    const definition = this.definitions.get(name);
    if (!definition) throw new TypeError(`Unknown job "${name}"`);

    const submit = async (
      input: unknown,
      options: SubmitOptions = {}
    ): Promise<JobHandle> => {
      this.assertOpen();
      if (this.events) await this.events;
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
        toJobsOptions(options, definition.policy, this.logLimit)
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
      this.assertOpen();
      if (options.ids && options.ids.length !== inputs.length) {
        throw new RangeError("bulk ids must match the number of inputs");
      }
      if (this.events) await this.events;
      const values = await Promise.all(
        inputs.map(async (input) =>
          this.check(await validateInput(name, definition.schema, input))
        )
      );
      const created = await this.queue.addBulk(
        values.map((data, index) => ({
          name,
          data,
          opts: toJobsOptions(
            { ...options, id: options.ids?.[index] } as SubmitOptions,
            definition.policy,
            this.logLimit
          ),
        }))
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
      const handle = this.scheduleHandle(id, name);
      await handle.refresh();
      return handle;
    };

    const callable = submit as unknown as Record<string, unknown>;
    Object.defineProperties(callable, {
      bulk: { value: bulk, enumerable: true },
      schedule: { value: schedule, enumerable: true },
      input: { value: definition.schema, enumerable: true },
    });
    return callable as unknown as JobCallable<
      unknown,
      unknown,
      unknown,
      string,
      StandardSchemaV1 | undefined
    >;
  }

  private scheduleHandle(id: string, jobName: string): ScheduleHandle {
    let cachedNext = 0;
    const queue = this.queue;
    return {
      get id() {
        return id;
      },
      get nextRunAt() {
        return cachedNext;
      },
      remove: async () => {
        await queue.removeJobScheduler(id);
      },
      refresh: async (): Promise<ScheduleSnapshot> => {
        const scheduler = await queue.getJobScheduler(id);
        if (!scheduler) throw new Error(`Schedule "${id}" does not exist`);
        cachedNext = Number(scheduler.next ?? 0);
        return {
          id,
          jobName,
          cron: String(scheduler.pattern ?? ""),
          timezone: String(scheduler.tz ?? "UTC"),
          nextRunAt: cachedNext,
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
        const types = query.status
          ? [bullTypeFor(query.status)]
          : ["waiting", "prioritized", "delayed", "active", "completed", "failed"];
        const bulls = await this.queue.getJobs(
          types as never,
          offset,
          offset + limit - 1
        );
        const jobs = await Promise.all(
          bulls.map(async (bull) =>
            toSnapshot(bull, toStatus(await bull.getState()))
          )
        );
        const page: JobListPage<AnyJobSnapshot<Definitions>> = {
          jobs: jobs as AnyJobSnapshot<Definitions>[],
        };
        if (jobs.length === limit) page.cursor = String(offset + limit);
        return page;
      },

      stats: async (): Promise<QueueStats> => {
        const counts = await this.queue.getJobCounts();
        const stats: QueueStats = {
          queued: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
          scheduled: counts.delayed ?? 0,
          running: counts.active ?? 0,
          succeeded: counts.completed ?? 0,
          failed: counts.failed ?? 0,
          total: 0,
        };
        stats.total =
          stats.queued +
          stats.scheduled +
          stats.running +
          stats.succeeded +
          stats.failed;
        return stats;
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
        const removed = await this.queue.clean(
          olderThan,
          query.limit ?? 1000,
          query.status === "failed" ? "failed" : "completed"
        );
        // Markers outlive their jobs otherwise, so the hash grows forever.
        const client = await this.markers();
        const markers = await client.hgetall(this.cancelledKey());
        const threshold = Date.now() - olderThan;
        const stale = Object.entries(markers)
          .filter(([, raw]) => {
            try {
              return (JSON.parse(raw) as { at: number }).at <= threshold;
            } catch {
              return true;
            }
          })
          .map(([id]) => id);
        if (stale.length > 0) await client.hdel(this.cancelledKey(), ...stale);
        return removed;
      },

      on: <Event extends keyof QueueEventMap>(
        event: Event,
        listener: (payload: QueueEventMap[Event]) => void
      ) => {
        const bullEvent = {
          added: "added",
          started: "active",
          progress: "progress",
          succeeded: "completed",
          failed: "failed",
          error: "error",
        }[event];
        const handler = (payload: { jobId?: string }): void => {
          if (event === "error") {
            listener(payload as never);
            return;
          }
          void this.snapshotOf(String(payload.jobId)).then((snapshot) => {
            if (snapshot) listener(snapshot as never);
          });
        };
        // Attaching has to wait for the stream to open, so unsubscribing
        // before that has to be remembered rather than applied.
        let detach: (() => void) | undefined;
        let unsubscribed = false;
        void this.queueEvents().then((events) => {
          if (unsubscribed) return;
          events.on(bullEvent as never, handler as never);
          detach = () => events.off(bullEvent as never, handler as never);
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
        facade.workerRunning = true;
      },
      pause: async () => {
        await facade.worker?.pause();
        facade.workerRunning = false;
      },
      resume: async () => {
        facade.worker?.resume();
        facade.workerRunning = true;
      },
      onIdle: async () => {
        // BullMQ has no idle signal, so poll the counts it already maintains
        // rather than tracking the same state in parallel.
        for (;;) {
          const counts = await facade.queue.getJobCounts(
            "waiting",
            "active",
            "delayed",
            "prioritized"
          );
          const outstanding =
            (counts.waiting ?? 0) +
            (counts.active ?? 0) +
            (counts.delayed ?? 0) +
            (counts.prioritized ?? 0);
          if (outstanding === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      close: async (options?: { drain?: boolean }) => {
        if ((options?.drain ?? true) && facade.worker && facade.workerRunning) {
          await facade.api.worker.onIdle();
        }
        facade.closed = true;
        facade.workerRunning = false;
        await facade.worker?.close();
        await (await facade.events)?.close();
        await facade.queue.close();
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
