/** The Redis-backed queue engine: claiming, execution, schedules and events. */

import {
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
} from "../memory.js";
import type {
  AddOptions,
  JobContext,
  JobInput,
  JobLogEntry,
  JobMap,
  JobName,
  JobOutput,
  JobSnapshot,
  JobStatus,
  QueueEventMap,
  QueueOptions,
  QueueStats,
  RateLimitOptions,
} from "../memory.js";
import {
  errorFromSerialized,
  serializeError,
  toError,
  type SerializedError,
} from "../internal/errors.js";
import {
  backoffFromOptions,
  resolveRunAt,
  sleep,
  type BackoffOptions,
} from "../internal/timing.js";
import {
  nonNegativeInteger,
  nonNegativeNumber,
  positiveInteger,
  positiveIntegerOrInfinity,
  positiveNumber,
} from "../internal/validate.js";
import {
  decodeJobValue as decode,
  encodeJobValue as encode,
} from "../codec.js";
import {
  nextCronOccurrence,
  parseCron,
  validateTimeZone,
} from "../cron.js";
import { compact } from "../internal/object.js";
import {
  applySnapshot,
  snapshotForEvent,
  snapshotFromFields,
} from "./snapshot.js";
import type {
  ClaimedJob,
  NormalizedRedisRetry,
  RedisAddOptions,
  RedisCommandClient,
  RedisDriver,
  RedisDriverConfig,
  RedisDriverOptions,
  RedisJob,
  RedisJobRecord,
  RedisListOptions,
  RedisListPage,
  RedisQueueEventMap,
  RedisQueueOptions,
  RedisRetryOptions,
  RedisScheduleHandle,
  RedisScheduleRegistration,
  RedisScheduleSnapshot,
} from "./types.js";

import { queueKeys } from "./keys.js";
import { firstStreamEntryId, streamEntries } from "./stream.js";
import {
  ADVANCE_SCHEDULE_SCRIPT,
  CANCEL_SCRIPT,
  CLAIM_SCRIPT,
  COMPLETE_SCRIPT,
  ENQUEUE_SCRIPT,
  FAIL_SCRIPT,
  HEARTBEAT_SCRIPT,
  REDRIVE_SCRIPT,
  REMOVE_SCRIPT,
  STATS_SCRIPT,
  UPSERT_SCHEDULE_SCRIPT,
} from "./scripts.js";

import type {
  DriverCleanupQuery,
  DriverFactory,
  DriverHandlers,
  DriverJob,
  DriverListPage,
  DriverListQuery,
  DriverQueueOptions,
  DriverScheduleRegistration,
  QueueDriver,
  ScheduleHandle,
  ScheduleSnapshot,
} from "../driver.js";



export class RedisQueue<Jobs extends JobMap> {
  readonly name: string;

  private readonly handlers: Jobs;
  private readonly driver: RedisDriverConfig;
  private readonly workerEnabled: boolean;
  private concurrency: number;
  private readonly retry: NormalizedRedisRetry;
  private readonly timeout: number | undefined;
  private readonly rateLimit: RateLimitOptions | undefined;
  private readonly historyLimit: number;
  private readonly logLimit: number;
  private readonly keys: ReturnType<typeof queueKeys>;
  private readonly local = new Map<string, RedisJobRecord>();
  private readonly listeners = new Map<
    keyof RedisQueueEventMap,
    Set<(payload: never) => void>
  >();
  private readonly running = new Set<Promise<void>>();

  private started: boolean;
  private closed = false;
  private workerLoop: Promise<void> | undefined;
  private eventLoop: Promise<void> | undefined;
  private eventCursor: string | undefined;
  private sequence = 0;

  constructor(handlers: Jobs, options: RedisQueueOptions) {
    if (Object.keys(handlers).length === 0) {
      throw new TypeError("At least one job handler is required");
    }

    this.handlers = handlers;
    this.driver = options.driver;
    this.name = options.name?.trim() || "default";
    this.workerEnabled = options.worker ?? true;
    this.concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;
    this.retry = normalizeRetry(options.retry);
    this.timeout = options.timeout;
    this.rateLimit = options.rateLimit;
    this.historyLimit = options.historyLimit ?? 1000;
    this.logLimit = options.logLimit ?? 100;
    this.started = options.autoStart ?? true;
    this.keys = queueKeys(this.driver.prefix, this.name);

    positiveIntegerOrInfinity("concurrency", this.concurrency);
    // The in-memory driver accepts 0 here. Redis trims its terminal lists with
    // LTRIM, which cannot express "retain nothing", so this driver requires at
    // least 1 and says so rather than silently clamping the value.
    positiveInteger("historyLimit", this.historyLimit);
    nonNegativeInteger("logLimit", this.logLimit);
    if (this.timeout !== undefined) {
      positiveNumber("timeout", this.timeout);
    }
    if (this.rateLimit) {
      positiveInteger("rateLimit.limit", this.rateLimit.limit);
      positiveNumber("rateLimit.interval", this.rateLimit.interval);
    }
    if (this.started && this.workerEnabled) {
      this.ensureWorker();
    }
  }

  add<Name extends JobName<Jobs>>(
    name: Name,
    input: JobInput<Jobs, Name>,
    options: RedisAddOptions = {}
  ): RedisJob<JobOutput<Jobs, Name>, JobInput<Jobs, Name>, Name> {
    this.assertOpen();
    if (typeof this.handlers[name] !== "function") {
      throw new TypeError(`Unknown job "${name}"`);
    }

    const now = Date.now();
    const requestedRunAt = resolveRunAt(options.delay, now);
    const resolvedRunAt =
      options.debounce?.mode === "trailing"
        ? Math.max(requestedRunAt, now + options.debounce.wait)
        : requestedRunAt;
    const record: RedisJobRecord = {
      id: options.id ?? createId(this.name, String(name), now, this.nextSequence()),
      name: String(name),
      input,
      status: resolvedRunAt > now ? "scheduled" : "queued",
      priority: options.priority ?? 0,
      attempt: 0,
      retry:
        options.retry === undefined
          ? this.retry
          : normalizeRetry(options.retry),
      timeout: options.timeout ?? this.timeout,
      expiresAt:
        options.expiresIn === undefined
          ? undefined
          : now + options.expiresIn,
      keyRetention: options.keyRetention ?? 0,
      concurrency: options.concurrency,
      throttle: options.throttle,
      debounce: options.debounce,
      createdAt: now,
      runAt: resolvedRunAt,
      startedAt: undefined,
      finishedAt: undefined,
      progress: undefined,
      output: undefined,
      error: undefined,
      logs: [],
      deduplicated: false,
      submission: Promise.resolve(),
      submissionError: undefined,
    };

    if (!record.id) {
      throw new TypeError("Job ID must not be empty");
    }
    if (!Number.isFinite(record.priority)) {
      throw new RangeError("priority must be a finite number");
    }
    if (record.timeout !== undefined) {
      positiveNumber("timeout", record.timeout);
    }
    if (options.expiresIn !== undefined) {
      positiveNumber("expiresIn", options.expiresIn);
    }
    nonNegativeNumber("keyRetention", record.keyRetention);

    record.submission = this.enqueue(record, options.key).catch((cause) => {
      const error = toError(cause);
      record.submissionError = error;
      record.status = "failed";
      record.error = serializeError(error);
      record.finishedAt = Date.now();
      this.emit("error", error);
      throw error;
    });
    // Mark the rejection handled until a consumer reads `accepted` or `result`.
    void record.submission.catch(() => undefined);

    this.local.set(record.id, record);
    return this.handle(record);
  }

  addMany<Name extends JobName<Jobs>>(
    name: Name,
    inputs: readonly JobInput<Jobs, Name>[],
    options?: RedisAddOptions
  ): Array<RedisJob<JobOutput<Jobs, Name>, JobInput<Jobs, Name>, Name>> {
    return inputs.map((input) => this.add(name, input, options));
  }

  async get(id: string): Promise<JobSnapshot | undefined> {
    const values = await this.command("HMGET", [
      this.keys.meta + id,
      "id",
      "name",
      "input",
      "status",
      "priority",
      "attempt",
      "retries",
      "createdAt",
      "runAt",
      "expiresAt",
      "startedAt",
      "finishedAt",
      "progress",
      "output",
      "error",
      "logs",
    ]);
    if (!Array.isArray(values) || values[0] === null) {
      return undefined;
    }
    const result = snapshotFromFields(values);
    const local = this.local.get(id);
    if (local) {
      applySnapshot(local, result);
    }
    return result;
  }

  async list(options: RedisListOptions = {}): Promise<RedisListPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("list.limit must be an integer between 1 and 1000");
    }
    const offset = options.cursor === undefined
      ? 0
      : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new TypeError("Invalid list cursor");
    }
    const minimum = options.after === undefined
      ? "-inf"
      : `(${options.after}`;
    const maximum = options.before === undefined
      ? "+inf"
      : `(${options.before}`;
    const scanSize = Math.min(4000, Math.max(limit * 4, limit));
    const raw = await this.command("ZRANGEBYSCORE", [
      this.keys.all,
      minimum,
      maximum,
      "LIMIT",
      String(offset),
      String(scanSize),
    ]);
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    const jobs: JobSnapshot[] = [];
    for (const id of ids) {
      const snapshot = await this.get(id);
      if (!snapshot) {
        await this.command("ZREM", [this.keys.all, id]);
        continue;
      }
      if (
        (options.status && snapshot.status !== options.status) ||
        (options.name && snapshot.name !== options.name)
      ) {
        continue;
      }
      jobs.push(snapshot);
      if (jobs.length >= limit) {
        break;
      }
    }
    const nextOffset = offset + ids.length;
    return ids.length === scanSize
      ? { jobs, cursor: String(nextOffset) }
      : { jobs };
  }

  async cleanup(options: {
    status?: JobStatus | readonly JobStatus[];
    olderThan?: number;
    limit?: number;
  } = {}): Promise<string[]> {
    const olderThan = options.olderThan ?? 0;
    const limit = options.limit ?? 1000;
    nonNegativeNumber("cleanup.olderThan", olderThan);
    if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
      throw new RangeError(
        "cleanup.limit must be an integer between 0 and 10000"
      );
    }
    const statuses = new Set(cleanupStatuses(options.status));
    const threshold = Date.now() - olderThan;
    const removed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(
        cursor === undefined ? { limit: 1000 } : { limit: 1000, cursor }
      );
      for (const job of page.jobs) {
        if (
          removed.length >= limit ||
          !statuses.has(job.status) ||
          (job.finishedAt ?? Number.POSITIVE_INFINITY) > threshold
        ) {
          continue;
        }
        const result = await this.eval(
          REMOVE_SCRIPT,
          [
            this.keys.meta,
            this.keys.ready,
            this.keys.delayed,
            this.keys.active,
            this.keys.completed,
            this.keys.failed,
            this.keys.cancelled,
            this.keys.expired,
            this.keys.dedupe,
            this.keys.expiring,
            this.keys.all,
          ],
          [job.id]
        );
        if (Number(result) === 1) {
          this.local.delete(job.id);
          removed.push(job.id);
        }
      }
      cursor = page.cursor;
    } while (cursor && removed.length < limit);
    return removed;
  }

  async redrive(id: string): Promise<RedisJob<unknown>> {
    this.assertOpen();
    const result = await this.eval(
      REDRIVE_SCRIPT,
      [
        this.keys.meta,
        this.keys.sequence,
        this.keys.ready,
        this.keys.failed,
        this.keys.cancelled,
        this.keys.expired,
        this.keys.events,
      ],
      [id, String(Date.now())]
    );
    if (Number(result) !== 1) {
      throw new Error(`Job "${id}" cannot be redriven`);
    }
    const snapshot = await this.get(id);
    if (!snapshot) {
      throw new Error(`Job "${id}" no longer exists`);
    }
    const record = this.recordFromSnapshot(snapshot);
    this.local.set(id, record);
    return this.handle(record);
  }

  async pauseQueue(): Promise<void> {
    await this.command("HSET", [this.keys.config, "paused", "1"]);
  }

  async resumeQueue(): Promise<void> {
    await this.command("HDEL", [this.keys.config, "paused"]);
  }

  async setGlobalConcurrency(limit: number): Promise<void> {
    positiveInteger("global concurrency", limit);
    await this.command("HSET", [
      this.keys.config,
      "concurrency",
      String(limit),
    ]);
  }

  async upsertSchedule(
    registration: RedisScheduleRegistration
  ): Promise<RedisScheduleHandle> {
    this.assertOpen();
    parseCron(registration.cron);
    const timezone = validateTimeZone(registration.timezone ?? "UTC");
    const id = registration.id?.trim() || registration.jobName;
    if (!id) {
      throw new TypeError("schedule.id must not be empty");
    }
    const nextRunAt = nextCronOccurrence(
      registration.cron,
      timezone,
      Date.now()
    );
    const result = await this.eval(
      UPSERT_SCHEDULE_SCRIPT,
      [this.keys.scheduleMeta, this.keys.schedules],
      [
        id,
        registration.jobName,
        registration.cron,
        timezone,
        String(nextRunAt),
        encode(registration.input),
        registration.catchUp ? "1" : "0",
        encode(registration.submit),
      ]
    );
    if (
      !Array.isArray(result) ||
      String(result[0]) !== "ok"
    ) {
      const owner = Array.isArray(result) ? String(result[1]) : "another job";
      throw new Error(
        `Schedule "${id}" already belongs to job "${owner}"`
      );
    }
    return new RedisScheduleHandleImpl(this, id, nextRunAt);
  }

  async getSchedule(
    id: string
  ): Promise<RedisScheduleSnapshot | undefined> {
    const values = await this.command("HMGET", [
      this.keys.scheduleMeta + id,
      "id",
      "jobName",
      "cron",
      "timezone",
      "status",
      "nextRunAt",
      "input",
      "catchUp",
    ]);
    if (!Array.isArray(values) || values[0] === null) {
      return undefined;
    }
    return {
      id: String(values[0]),
      jobName: String(values[1]),
      cron: String(values[2]),
      timezone: String(values[3]),
      status: String(values[4]) as "active" | "paused",
      nextRunAt: Number(values[5]),
      input: decode(String(values[6])),
      catchUp: String(values[7]) === "1",
    };
  }

  async pauseSchedule(id: string): Promise<void> {
    if (!(await this.getSchedule(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.command("HSET", [
      this.keys.scheduleMeta + id,
      "status",
      "paused",
    ]);
    await this.command("ZREM", [this.keys.schedules, id]);
  }

  async resumeSchedule(id: string): Promise<number> {
    const schedule = await this.getSchedule(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    const nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      Date.now()
    );
    await this.command("HSET", [
      this.keys.scheduleMeta + id,
      "status",
      "active",
      "nextRunAt",
      String(nextRunAt),
    ]);
    await this.command("ZADD", [
      this.keys.schedules,
      String(nextRunAt),
      id,
    ]);
    return nextRunAt;
  }

  async removeSchedule(id: string): Promise<void> {
    if (!(await this.getSchedule(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.command("ZREM", [this.keys.schedules, id]);
    await this.command("DEL", [this.keys.scheduleMeta + id]);
  }

  async cancel(id: string, reason = "Job was cancelled"): Promise<boolean> {
    const error = serializeError(new JobCancelledError(id, reason));
    const result = await this.eval(
      CANCEL_SCRIPT,
      [
        this.keys.meta,
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.cancelled,
        this.keys.dedupe,
        this.keys.expiring,
        this.keys.activeKeys,
        this.keys.events,
      ],
      [
        id,
        String(Date.now()),
        JSON.stringify(error),
        String(this.driver.retention),
        String(this.historyLimit),
      ]
    );
    const cancelled = Number(result) === 1;
    if (cancelled) {
      const local = this.local.get(id);
      if (local) {
        local.status = "cancelled";
        local.error = error;
        local.finishedAt = Date.now();
      }
    }
    return cancelled;
  }

  async stats(): Promise<QueueStats> {
    const result = await this.eval(
      STATS_SCRIPT,
      [
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.completed,
        this.keys.failed,
        this.keys.cancelled,
        this.keys.expired,
      ],
      []
    );
    const values = Array.isArray(result) ? result.map(Number) : [];
    const stats: QueueStats = {
      queued: values[0] ?? 0,
      scheduled: values[1] ?? 0,
      running: values[2] ?? 0,
      succeeded: values[3] ?? 0,
      failed: values[4] ?? 0,
      cancelled: values[5] ?? 0,
      expired: values[6] ?? 0,
      total: 0,
    };
    stats.total =
      stats.queued +
      stats.scheduled +
      stats.running +
      stats.succeeded +
      stats.failed +
      stats.cancelled +
      stats.expired;
    return stats;
  }

  pause(): this {
    this.assertOpen();
    this.started = false;
    return this;
  }

  start(): this {
    this.assertOpen();
    this.started = true;
    if (this.workerEnabled) {
      this.ensureWorker();
    }
    return this;
  }

  setWorkerConcurrency(limit: number): void {
    positiveIntegerOrInfinity("worker concurrency", limit);
    this.concurrency = limit;
  }

  async onIdle(): Promise<void> {
    while (this.running.size > 0) {
      await sleep(this.driver.pollInterval);
    }
  }

  async close(options: { drain?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.started = false;
    if (options.drain ?? true) {
      await this.onIdle();
    }
    this.closed = true;
    await Promise.allSettled(this.running);
    await this.workerLoop;
    await this.eventLoop;
  }

  on<Event extends keyof RedisQueueEventMap>(
    event: Event,
    listener: (payload: RedisQueueEventMap[Event]) => void
  ): () => void {
    let group = this.listeners.get(event);
    if (!group) {
      group = new Set();
      this.listeners.set(event, group);
    }
    group.add(listener as (payload: never) => void);
    if (event !== "error" && event !== "idle") {
      this.ensureEventLoop();
    }
    return () => {
      group?.delete(listener as (payload: never) => void);
    };
  }

  /** @internal */
  async resultFor(record: RedisJobRecord): Promise<unknown> {
    await record.submission;
    while (true) {
      const current = await this.get(record.id);
      if (!current) {
        throw new Error(`Job "${record.id}" no longer exists`);
      }
      if (current.status === "succeeded") {
        return current.output;
      }
      if (current.status === "failed") {
        throw new JobFailedError(
          record.id,
          current.error?.message ?? `Job "${record.id}" failed`
        );
      }
      if (current.status === "cancelled") {
        throw new JobCancelledError(record.id, current.error?.message);
      }
      if (current.status === "expired") {
        throw new JobExpiredError(record.id);
      }
      await sleep(this.driver.pollInterval);
    }
  }

  /** Monotonic suffix that keeps generated job IDs unique within a process. */
  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private handle<
    Output = unknown,
    Input = unknown,
    Name extends string = string,
  >(record: RedisJobRecord): RedisJob<Output, Input, Name> {
    return new RedisJobHandle<Output, Input, Name>(this, record);
  }

  private async enqueue(
    record: RedisJobRecord,
    key: string | undefined
  ): Promise<void> {
    const result = await this.eval(
      ENQUEUE_SCRIPT,
      [
        this.keys.meta,
        this.keys.sequence,
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.completed,
        this.keys.dedupe,
        this.keys.expiring,
        this.keys.debounce,
        this.keys.debounceExpiry,
        this.keys.events,
        this.keys.all,
      ],
      [
        record.id,
        record.name,
        encode(record.input),
        String(record.priority),
        String(record.runAt),
        String(record.createdAt),
        String(record.retry.retries),
        encode(record.retry.backoff),
        key ? `${record.name}:${key}` : "",
        record.timeout === undefined ? "" : String(record.timeout),
        record.expiresAt === undefined ? "" : String(record.expiresAt),
        String(record.keyRetention),
        record.concurrency?.key ?? "",
        record.concurrency === undefined
          ? ""
          : String(record.concurrency.limit),
        record.throttle?.key ?? "",
        record.throttle === undefined
          ? ""
          : String(record.throttle.limit),
        record.throttle === undefined
          ? ""
          : String(record.throttle.interval),
        record.throttle === undefined
          ? ""
          : String(record.throttle.burst),
        record.debounce
          ? `${record.name}:${record.debounce.key}`
          : "",
        record.debounce === undefined
          ? ""
          : String(record.debounce.wait),
        record.debounce?.mode ?? "",
      ]
    );
    if (!Array.isArray(result)) {
      throw new Error("Redis returned an invalid enqueue response");
    }
    const outcome = String(result[0]);
    const id = String(result[1]);
    if (outcome === "duplicate") {
      throw new Error(`Job ID "${id}" already exists`);
    }
    if (outcome === "deduplicated" || outcome === "debounced") {
      this.local.delete(record.id);
      record.id = id;
      record.deduplicated = true;
      const existing = await this.get(id);
      if (existing) {
        applySnapshot(record, existing);
      }
      this.local.set(id, record);
    }
  }

  private ensureWorker(): void {
    if (this.workerLoop || this.closed || !this.workerEnabled) {
      return;
    }
    this.workerLoop = this.work().finally(() => {
      this.workerLoop = undefined;
    });
  }

  private async work(): Promise<void> {
    while (!this.closed) {
      if (!this.started) {
        await sleep(this.driver.pollInterval);
        continue;
      }
      if (this.running.size >= this.concurrency) {
        await Promise.race(this.running);
        continue;
      }

      try {
        await this.processSchedules();
        const claimed = await this.claim();
        if (!claimed) {
          if (this.running.size > 0) {
            await Promise.race([
              ...this.running,
              sleep(this.driver.pollInterval),
            ]);
          } else {
            await sleep(this.driver.pollInterval);
          }
          continue;
        }

        const execution = this.execute(claimed).finally(() => {
          this.running.delete(execution);
        });
        this.running.add(execution);
      } catch (cause) {
        this.emit("error", toError(cause));
        await sleep(Math.max(1000, this.driver.pollInterval));
      }
    }
  }

  private async claim(): Promise<ClaimedJob | undefined> {
    const token = randomToken();
    const leaseError = serializeError(
      new Error("Worker lease expired before the job completed")
    );
    leaseError.name = "WorkerLeaseExpiredError";
    const result = await this.eval(
      CLAIM_SCRIPT,
      [
        this.keys.meta,
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.starts,
        this.keys.completed,
        this.keys.failed,
        this.keys.dedupe,
        this.keys.expiring,
        this.keys.expired,
        this.keys.config,
        this.keys.activeKeys,
        this.keys.throttleTokens,
        this.keys.throttleUpdated,
        this.keys.events,
        this.keys.debounce,
        this.keys.debounceExpiry,
      ],
      [
        String(Date.now()),
        token,
        String(this.driver.visibilityTimeout),
        String(this.rateLimit?.limit ?? 0),
        String(this.rateLimit?.interval ?? 0),
        "100",
        JSON.stringify(leaseError),
        String(this.driver.retention),
        String(this.historyLimit),
        JSON.stringify({
          name: "JobExpiredError",
          message: "Job expired before it could start",
        }),
      ]
    );
    if (!Array.isArray(result) || result[0] !== "job") {
      return undefined;
    }
    return {
      id: String(result[1]),
      name: String(result[2]),
      input: decode(String(result[3])),
      attempt: Number(result[4]),
      retry: {
        retries: Number(result[5]),
        backoff: decode(String(result[6])) as
          | number
          | BackoffOptions
          | undefined,
      },
      timeout:
        result[7] === "" || result[7] === null
          ? undefined
          : Number(result[7]),
      token,
    };
  }

  private async processSchedules(): Promise<void> {
    const now = Date.now();
    const raw = await this.command("ZRANGEBYSCORE", [
      this.keys.schedules,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      "20",
    ]);
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    for (const id of ids) {
      const values = await this.command("HMGET", [
        this.keys.scheduleMeta + id,
        "jobName",
        "cron",
        "timezone",
        "status",
        "nextRunAt",
        "input",
        "catchUp",
        "submit",
      ]);
      if (!Array.isArray(values) || values[0] === null) {
        await this.command("ZREM", [this.keys.schedules, id]);
        continue;
      }
      if (String(values[3]) !== "active") {
        await this.command("ZREM", [this.keys.schedules, id]);
        continue;
      }

      const jobName = String(values[0]);
      const cron = String(values[1]);
      const timezone = String(values[2]);
      const occurrence = Number(values[4]);
      const input = decode(String(values[5]));
      const catchUp = String(values[6]) === "1";
      const submit = decode(String(values[7])) as RedisAddOptions;
      const nextRunAt = nextCronOccurrence(
        cron,
        timezone,
        catchUp ? occurrence : now
      );
      const occurrenceId = `${this.name}:schedule:${id}:${occurrence}`;

      let accepted = false;
      try {
        const handle = this.add(jobName as JobName<Jobs>, input as never, {
          ...submit,
          id: occurrenceId,
        });
        await handle.accepted;
        accepted = true;
      } catch (cause) {
        const error = toError(cause);
        if (error.message.includes(`Job ID "${occurrenceId}" already exists`)) {
          accepted = true;
        } else {
          this.emit("error", error);
        }
      }
      if (!accepted) {
        continue;
      }
      await this.eval(
        ADVANCE_SCHEDULE_SCRIPT,
        [this.keys.scheduleMeta, this.keys.schedules],
        [id, String(occurrence), String(nextRunAt)]
      );
    }
  }

  private async execute(claimed: ClaimedJob): Promise<void> {
    const handler = this.handlers[claimed.name as JobName<Jobs>];
    if (typeof handler !== "function") {
      await this.fail(
        claimed,
        new Error(`No handler registered for job "${claimed.name}"`),
        false,
        0
      );
      return;
    }

    const local =
      this.local.get(claimed.id) ??
      this.localRecordFromClaim(claimed);
    local.status = "running";
    local.attempt = claimed.attempt;
    local.startedAt = Date.now();

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.heartbeat(claimed, controller);
    }, Math.max(100, Math.floor(this.driver.visibilityTimeout / 3)));

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context: JobContext = {
        id: claimed.id,
        name: claimed.name,
        attempt: claimed.attempt,
        signal: controller.signal,
        progress: (value: unknown): void => {
          local.progress = value;
          void this.command("HSET", [
            this.keys.meta + claimed.id,
            "progress",
            encode(value),
          ])
            .then(() => this.publishEvent("progress", claimed.id))
            .catch((cause) => this.emit("error", toError(cause)));
        },
        log: (entry: JobLogEntry): void => {
          if (this.logLimit === 0) {
            return;
          }
          local.logs.push(entry);
          if (local.logs.length > this.logLimit) {
            local.logs.splice(0, local.logs.length - this.logLimit);
          }
          void this.command("HSET", [
            this.keys.meta + claimed.id,
            "logs",
            encode(local.logs),
          ])
            .then(() => this.publishEvent("log", claimed.id))
            .catch((cause) => this.emit("error", toError(cause)));
        },
      };
      const execution = Promise.resolve(handler(claimed.input, context));
      const output =
        claimed.timeout === undefined
          ? await execution
          : await Promise.race([
              execution,
              new Promise<never>((_, reject) => {
                timeoutTimer = setTimeout(() => {
                  const error = new JobTimeoutError(
                    claimed.id,
                    claimed.timeout as number
                  );
                  controller.abort(error);
                  reject(error);
                }, claimed.timeout);
              }),
            ]);

      const completed = await this.complete(claimed, output);
      if (completed) {
        local.status = "succeeded";
        local.output = output;
        local.finishedAt = Date.now();
      }
    } catch (cause) {
      const error = toError(cause);
      const retry =
        claimed.attempt <= claimed.retry.retries;
      const delay = retry
        ? retryDelay(claimed.retry.backoff, claimed.attempt)
        : 0;
      const failed = await this.fail(claimed, error, retry, delay);
      if (failed) {
        local.error = serializeError(error);
        if (retry) {
          local.status = delay > 0 ? "scheduled" : "queued";
          local.runAt = Date.now() + delay;
        } else {
          local.status = "failed";
          local.finishedAt = Date.now();
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }
  }

  private async heartbeat(
    job: ClaimedJob,
    controller: AbortController
  ): Promise<void> {
    try {
      const result = await this.eval(
        HEARTBEAT_SCRIPT,
        [this.keys.meta, this.keys.active],
        [
          job.id,
          job.token,
          String(Date.now() + this.driver.visibilityTimeout),
        ]
      );
      if (Number(result) !== 1 && !controller.signal.aborted) {
        controller.abort(new JobCancelledError(job.id, "Job ownership lost"));
      }
    } catch (cause) {
      this.emit("error", toError(cause));
    }
  }

  private async complete(job: ClaimedJob, output: unknown): Promise<boolean> {
    const result = await this.eval(
      COMPLETE_SCRIPT,
      [
        this.keys.meta,
        this.keys.active,
        this.keys.completed,
        this.keys.dedupe,
        this.keys.activeKeys,
        this.keys.events,
      ],
      [
        job.id,
        job.token,
        String(Date.now()),
        encode(output),
        String(this.driver.retention),
        String(this.historyLimit),
      ]
    );
    return Number(result) === 1;
  }

  private async fail(
    job: ClaimedJob,
    error: Error,
    retry: boolean,
    delay: number
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.eval(
      FAIL_SCRIPT,
      [
        this.keys.meta,
        this.keys.active,
        this.keys.ready,
        this.keys.delayed,
        this.keys.failed,
        this.keys.dedupe,
        this.keys.activeKeys,
        this.keys.expiring,
        this.keys.events,
      ],
      [
        job.id,
        job.token,
        retry ? "1" : "0",
        JSON.stringify(serializeError(error)),
        String(now + delay),
        String(now),
        String(this.driver.retention),
        String(this.historyLimit),
      ]
    );
    return Number(result) === 1;
  }

  private localRecordFromClaim(claimed: ClaimedJob): RedisJobRecord {
    const now = Date.now();
    const record: RedisJobRecord = {
      id: claimed.id,
      name: claimed.name,
      input: claimed.input,
      status: "running",
      priority: 0,
      attempt: claimed.attempt,
      retry: claimed.retry,
      timeout: claimed.timeout,
      expiresAt: undefined,
      keyRetention: 0,
      concurrency: undefined,
      throttle: undefined,
      debounce: undefined,
      createdAt: now,
      runAt: now,
      startedAt: now,
      finishedAt: undefined,
      progress: undefined,
      output: undefined,
      error: undefined,
      logs: [],
      deduplicated: false,
      submission: Promise.resolve(),
      submissionError: undefined,
    };
    this.local.set(record.id, record);
    return record;
  }

  private recordFromSnapshot(snapshot: JobSnapshot): RedisJobRecord {
    return {
      id: snapshot.id,
      name: snapshot.name,
      input: snapshot.input,
      status: snapshot.status,
      priority: snapshot.priority,
      attempt: snapshot.attempt,
      retry: {
        retries: snapshot.retries,
        backoff: undefined,
      },
      timeout: undefined,
      expiresAt: snapshot.expiresAt,
      keyRetention: 0,
      concurrency: undefined,
      throttle: undefined,
      debounce: undefined,
      createdAt: snapshot.createdAt,
      runAt: snapshot.runAt,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      progress: snapshot.progress,
      output: snapshot.output,
      error: snapshot.error,
      logs: [...(snapshot.logs ?? [])],
      deduplicated: false,
      submission: Promise.resolve(),
      submissionError: undefined,
    };
  }

  private ensureEventLoop(): void {
    if (this.eventLoop || this.closed) {
      return;
    }
    this.eventLoop = this.readEvents().finally(() => {
      this.eventLoop = undefined;
    });
  }

  private async readEvents(): Promise<void> {
    if (this.eventCursor === undefined) {
      const latest = await this.command("XREVRANGE", [
        this.keys.events,
        "+",
        "-",
        "COUNT",
        "1",
      ]);
      this.eventCursor = firstStreamEntryId(latest) ?? "0-0";
    }
    while (!this.closed && this.hasEventListeners()) {
      try {
        const result = await this.command("XREAD", [
          "COUNT",
          "100",
          "STREAMS",
          this.keys.events,
          this.eventCursor,
        ]);
        const entries = streamEntries(result);
        for (const entry of entries) {
          this.eventCursor = entry.id;
          await this.dispatchRemoteEvent(entry.fields);
        }
      } catch (cause) {
        this.emit("error", toError(cause));
      }
      await sleep(this.driver.pollInterval);
    }
  }

  private hasEventListeners(): boolean {
    for (const [event, listeners] of this.listeners) {
      if (event !== "error" && event !== "idle" && listeners.size > 0) {
        return true;
      }
    }
    return false;
  }

  private async dispatchRemoteEvent(
    fields: ReadonlyMap<string, string>
  ): Promise<void> {
    const type = fields.get("type") as keyof RedisQueueEventMap | undefined;
    const id = fields.get("id");
    if (!type || !id || type === "error" || type === "idle") {
      return;
    }
    const value = await this.get(id);
    if (!value) {
      return;
    }
    const at = Number(fields.get("at") ?? Date.now());
    const snapshot = snapshotForEvent(type, value, at);
    if (type === "retry") {
      const error = errorFromSerialized(snapshot.error);
      this.emit("retry", {
        job: snapshot,
        error,
        delay: Math.max(0, snapshot.runAt - at),
      });
      return;
    }
    if (type === "log") {
      const entry = snapshot.logs?.at(-1);
      if (entry) {
        this.emit("log", { job: snapshot, entry });
      }
      return;
    }
    if (type === "recovered") {
      this.emit("recovered", snapshot);
      return;
    }
    this.emit(
      type as Exclude<
        keyof RedisQueueEventMap,
        "error" | "idle" | "retry" | "log" | "recovered"
      >,
      snapshot
    );
  }

  private async publishEvent(type: string, id: string): Promise<void> {
    await this.command("XADD", [
      this.keys.events,
      "MAXLEN",
      "~",
      "10000",
      "*",
      "type",
      type,
      "id",
      id,
      "at",
      String(Date.now()),
    ]);
  }

  private async command(
    command: string,
    arguments_: string[]
  ): Promise<unknown> {
    if (this.driver.client.send) {
      return this.driver.client.send(command, arguments_);
    }
    if (this.driver.client.sendCommand) {
      return this.driver.client.sendCommand([command, ...arguments_]);
    }
    throw new TypeError("Invalid Redis command client");
  }

  private eval(
    script: string,
    keys: string[],
    arguments_: string[]
  ): Promise<unknown> {
    return this.command("EVAL", [
      script,
      String(keys.length),
      ...keys,
      ...arguments_,
    ]);
  }

  private emit<Event extends keyof RedisQueueEventMap>(
    event: Event,
    payload: RedisQueueEventMap[Event]
  ): void {
    const group = this.listeners.get(event);
    if (!group) {
      return;
    }
    for (const listener of group) {
      try {
        listener(payload as never);
      } catch {
        // Observers cannot interrupt queue processing.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new QueueClosedError(this.name);
    }
  }
}

class RedisJobHandle<Output, Input, Name extends string>
  implements RedisJob<Output, Input, Name>
{
  constructor(
    private readonly owner: RedisQueue<JobMap>,
    private readonly record: RedisJobRecord
  ) {}

  get id(): string {
    return this.record.id;
  }

  get name(): Name {
    return this.record.name as Name;
  }

  get input(): Input {
    return this.record.input as Input;
  }

  get status(): JobStatus {
    return this.record.status;
  }

  get deduplicated(): boolean {
    return this.record.deduplicated;
  }

  get accepted(): Promise<void> {
    return this.record.submission;
  }

  get result(): Promise<Output> {
    return this.owner.resultFor(this.record) as Promise<Output>;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.owner.cancel(this.id, reason);
  }

  async refresh(): Promise<JobSnapshot<Input, Output, Name>> {
    await this.accepted;
    const value = await this.owner.get(this.id);
    if (!value) {
      throw new Error(`Job "${this.id}" no longer exists`);
    }
    return value as JobSnapshot<Input, Output, Name>;
  }

}

/** Presents a Redis job through the driver contract. */

class RedisScheduleHandleImpl implements RedisScheduleHandle {
  private cachedNextRunAt: number;

  constructor(
    private readonly owner: RedisQueue<JobMap>,
    readonly id: string,
    nextRunAt: number
  ) {
    this.cachedNextRunAt = nextRunAt;
  }

  get nextRunAt(): number {
    return this.cachedNextRunAt;
  }

  async pause(): Promise<void> {
    await this.owner.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    this.cachedNextRunAt = await this.owner.resumeSchedule(this.id);
  }

  async remove(): Promise<void> {
    await this.owner.removeSchedule(this.id);
  }

  async refresh(): Promise<RedisScheduleSnapshot> {
    const value = await this.owner.getSchedule(this.id);
    if (!value) {
      throw new Error(`Schedule "${this.id}" does not exist`);
    }
    this.cachedNextRunAt = value.nextRunAt;
    return value;
  }
}


/** Cleanup defaults to every terminal status when the caller names none. */

function cleanupStatuses(
  status: JobStatus | readonly JobStatus[] | undefined
): readonly JobStatus[] {
  if (status === undefined) {
    return ["succeeded", "failed", "cancelled", "expired"];
  }
  // JobStatus is a string union, so typeof narrows where Array.isArray does
  // not narrow the readonly-array side of the union.
  return typeof status === "string" ? [status] : status;
}

function normalizeRetry(
  retry: number | RedisRetryOptions | undefined
): NormalizedRedisRetry {
  if (retry === undefined) {
    return { retries: 0, backoff: undefined };
  }
  if (typeof retry === "number") {
    nonNegativeInteger("retry", retry);
    return { retries: retry, backoff: undefined };
  }
  nonNegativeInteger("retry.retries", retry.retries);
  if (typeof retry.backoff === "number" && retry.backoff < 0) {
    throw new RangeError("retry.backoff must not be negative");
  }
  return { retries: retry.retries, backoff: retry.backoff };
}

function retryDelay(
  backoff: NormalizedRedisRetry["backoff"],
  attempt: number
): number {
  if (backoff === undefined) {
    return 0;
  }
  if (typeof backoff === "number") {
    nonNegativeNumber("backoff delay", backoff);
    return backoff;
  }
  return backoffFromOptions(backoff, attempt);
}



function createId(
  queue: string,
  name: string,
  now: number,
  sequence: number
): string {
  return `${queue}:${name}:${now.toString(36)}:${sequence.toString(36)}:${randomToken()}`;
}

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return uuid;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}








