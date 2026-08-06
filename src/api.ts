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
import { cloneJobValue } from "./codec.js";
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

const reservedNames = new Set(["queue", "worker"]);

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
      await bull.updateProgress(cloneJobValue(progress) as never);
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
  private readonly cancelled = new Set<string>();
  private worker: Worker | undefined;
  private events: QueueEvents | undefined;
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
    this.queue = new Queue(this.queueName, this.bullBase());

    const workerOptions =
      options.worker === false ? undefined : options.worker ?? {};
    if (workerOptions) {
      this.worker = new Worker(
        this.queueName,
        async (bull: BullJob) => this.process(bull),
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
  private async process(bull: BullJob): Promise<unknown> {
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

    const controller = new AbortController();
    const context = createContext(
      bull,
      controller.signal,
      this.queueName,
      this.options.telemetry
    );
    const timeout = definition.policy.timeout ?? this.options.timeout;
    const execution = Promise.resolve(definition.run(bull.data, context));

    if (timeout === undefined) {
      return cloneJobValue(await execution);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return cloneJobValue(
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

  /** Lazily opened: only awaited results and subscriptions need the stream. */
  private queueEvents(): QueueEvents {
    this.events ??= new QueueEvents(this.queueName, this.bullBase());
    return this.events;
  }

  async awaitResult(bull: BullJob): Promise<unknown> {
    const id = String(bull.id);
    try {
      return await bull.waitUntilFinished(this.queueEvents());
    } catch (cause) {
      if (this.cancelled.has(id)) throw new JobCancelledError(id);
      const error = toError(cause);
      if (error.message.includes("timed out after")) throw error;
      if (error.message.includes("expired before it could start")) {
        throw new JobExpiredError(id);
      }
      throw new JobFailedError(id, error.message, { cause: error });
    }
  }

  async cancelJob(bull: BullJob, reason: string): Promise<boolean> {
    const id = String(bull.id);
    const state = await bull.getState();
    if (state === "completed" || state === "failed" || state === "unknown") {
      return false;
    }
    this.cancelled.add(id);
    try {
      await bull.remove();
    } catch {
      // BullMQ refuses to remove a job that is already running.
      this.cancelled.delete(id);
      return false;
    }
    this.options.telemetry?.emit({
      type: "job.cancelled",
      queue: this.queueName,
      timestamp: Date.now(),
      fields: { jobId: id, reason },
    });
    return true;
  }

  async snapshotOf(id: string): Promise<JobSnapshot | undefined> {
    const bull = await this.queue.getJob(id);
    if (bull) return toSnapshot(bull, toStatus(await bull.getState()));
    if (!this.cancelled.has(id)) return undefined;
    // A cancelled job is removed from Redis, so its final state lives here.
    return {
      id,
      name: "unknown",
      input: undefined,
      status: "cancelled",
      attempt: 0,
      createdAt: Date.now(),
      finishedAt: Date.now(),
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
      const value = cloneJobValue(
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
      const values = await Promise.all(
        inputs.map(async (input) =>
          cloneJobValue(await validateInput(name, definition.schema, input))
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
      const value = cloneJobValue(
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
        return this.queue.clean(
          olderThan,
          query.limit ?? 1000,
          query.status === "failed" ? "failed" : "completed"
        );
      },

      on: <Event extends keyof QueueEventMap>(
        event: Event,
        listener: (payload: QueueEventMap[Event]) => void
      ) => {
        const events = this.queueEvents();
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
        events.on(bullEvent as never, handler as never);
        return () => events.off(bullEvent as never, handler as never);
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
        await facade.events?.close();
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
