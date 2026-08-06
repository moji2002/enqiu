export type MaybePromise<T> = T | PromiseLike<T>;

export type JobStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface JobContext<Name extends string = string> {
  readonly id: string;
  readonly name: Name;
  readonly attempt: number;
  readonly signal: AbortSignal;
  progress(value: unknown): void;
  log(entry: JobLogEntry): void;
}

export type JobLogLevel = "debug" | "info" | "warn" | "error";

export interface JobLogEntry {
  readonly timestamp: number;
  readonly level: JobLogLevel;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export type JobHandler<
  Input = unknown,
  Output = unknown,
  Name extends string = string,
> = (
  input: Input,
  context: JobContext<Name>
) => MaybePromise<Output>;

// `any` is intentional: a job map may contain unrelated input/output types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JobMap = Record<string, JobHandler<any, any, any>>;

export type JobName<Jobs extends JobMap> = Extract<keyof Jobs, string>;
export type JobInput<
  Jobs extends JobMap,
  Name extends JobName<Jobs>,
> = Parameters<Jobs[Name]>[0];
export type JobOutput<
  Jobs extends JobMap,
  Name extends JobName<Jobs>,
> = Awaited<ReturnType<Jobs[Name]>>;

export interface BackoffOptions {
  type?: "fixed" | "exponential";
  delay: number;
  /**
   * Randomize each delay by up to this fraction.
   * `1` is full jitter; `0.2` produces a value between 80–100%.
   */
  jitter?: number;
}

export type BackoffStrategy =
  | number
  | BackoffOptions
  | ((attempt: number, error: Error) => MaybePromise<number>);

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  backoff?: BackoffStrategy;
  /** Return `false` to fail immediately instead of retrying this error. */
  when?: (error: Error, attempt: number) => MaybePromise<boolean>;
}

export interface RateLimitOptions {
  /** Maximum number of job starts in the interval. */
  limit: number;
  /** Rolling-window duration in milliseconds. */
  interval: number;
}

export interface KeyedConcurrencyOptions {
  limit: number;
  key: string;
}

export interface ThrottleOptions {
  limit: number;
  interval: number;
  burst: number;
  key: string;
}

export interface DebounceOptions {
  wait: number;
  mode: "leading" | "trailing";
  key: string;
}

export interface QueueOptions {
  /** Used in generated job IDs and diagnostics. */
  name?: string;
  /** Maximum number of handlers running at once. @default Infinity */
  concurrency?: number;
  /** Keep jobs queued until `start()` is called. @default true */
  autoStart?: boolean;
  /** Default retry policy. A number means retry that many times. */
  retry?: number | RetryOptions;
  /** Default per-attempt timeout in milliseconds. */
  timeout?: number;
  /** Optional strict rolling-window rate limit. */
  rateLimit?: RateLimitOptions;
  /** Number of finished jobs retained for inspection. @default 1000 */
  historyLimit?: number;
  /** Maximum structured log entries retained per job. @default 100 */
  logLimit?: number;
}

export interface AddOptions {
  /** Custom job ID. Duplicate IDs throw. */
  id?: string;
  /**
   * Single-flight key. While a matching job is unfinished, `add` returns it
   * instead of creating duplicate work.
   */
  key?: string;
  /** Delay in milliseconds, or an exact future date. */
  delay?: number | Date;
  /** Higher values run first. Equal priorities remain FIFO. */
  priority?: number;
  /** Override the queue retry policy. */
  retry?: number | RetryOptions;
  /** Override the queue per-attempt timeout. */
  timeout?: number;
  /** Expire before execution after this many milliseconds. */
  expiresIn?: number;
  /** Internal resolved per-key execution limit. */
  concurrency?: KeyedConcurrencyOptions;
  /** Internal resolved token-bucket policy. */
  throttle?: ThrottleOptions;
  /** Internal resolved debounce policy. */
  debounce?: DebounceOptions;
  /** Retain an idempotency key after completion for this duration. */
  keyRetention?: number;
  /** Cancels the job when aborted. */
  signal?: AbortSignal;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string | undefined;
}

export interface JobSnapshot<
  Input = unknown,
  Output = unknown,
  Name extends string = string,
> {
  id: string;
  name: Name;
  input: Input;
  status: JobStatus;
  priority: number;
  attempt: number;
  retries: number;
  createdAt: number;
  runAt: number;
  expiresAt?: number | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  progress?: unknown;
  output?: Output | undefined;
  error?: SerializedError | undefined;
  logs?: readonly JobLogEntry[] | undefined;
}

export interface QueueStats {
  queued: number;
  scheduled: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  expired: number;
  total: number;
}

export interface CleanupOptions {
  /** Only remove jobs with one of these terminal statuses. */
  status?: JobStatus | readonly JobStatus[];
  /** Only remove jobs finished at least this many milliseconds ago. @default 0 */
  olderThan?: number;
  /** Maximum number of jobs to remove. @default Infinity */
  limit?: number;
}

export interface CloseOptions {
  /** Finish queued and scheduled work before closing. @default true */
  drain?: boolean;
}

export interface QueueEventMap {
  added: JobSnapshot;
  started: JobSnapshot;
  progress: JobSnapshot;
  log: {
    job: JobSnapshot;
    entry: JobLogEntry;
  };
  retry: {
    job: JobSnapshot;
    error: Error;
    delay: number;
  };
  succeeded: JobSnapshot;
  failed: JobSnapshot;
  cancelled: JobSnapshot;
  expired: JobSnapshot;
  idle: QueueStats;
}

export class JobFailedError extends Error {
  readonly jobId: string;

  constructor(jobId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobFailedError";
    this.jobId = jobId;
  }
}

export class JobCancelledError extends Error {
  readonly jobId: string;

  constructor(jobId: string, message = "Job was cancelled") {
    super(message);
    this.name = "JobCancelledError";
    this.jobId = jobId;
  }
}

export class JobTimeoutError extends Error {
  readonly jobId: string;
  readonly timeout: number;

  constructor(jobId: string, timeout: number) {
    super(`Job "${jobId}" timed out after ${timeout}ms`);
    this.name = "JobTimeoutError";
    this.jobId = jobId;
    this.timeout = timeout;
  }
}

export class JobExpiredError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job "${jobId}" expired before it could start`);
    this.name = "JobExpiredError";
    this.jobId = jobId;
  }
}

export class QueueClosedError extends Error {
  constructor(name: string) {
    super(`Queue "${name}" is closed`);
    this.name = "QueueClosedError";
  }
}

/**
 * An awaitable handle returned synchronously by `queue.add()`.
 *
 * Ignoring a handle is safe: MemoryQueue does not create a rejecting promise until
 * the handle is awaited or `.result` is read.
 */
export interface Job<
  Output = unknown,
  Input = unknown,
  Name extends string = string,
> extends PromiseLike<Output> {
  readonly id: string;
  readonly name: Name;
  readonly input: Input;
  readonly status: JobStatus;
  readonly deduplicated: boolean;
  /** Resolves once the queue has accepted and stored the job. */
  readonly accepted: Promise<void>;
  readonly result: Promise<Output>;
  cancel(reason?: string): boolean;
  snapshot(): JobSnapshot<Input, Output, Name>;
  catch<Result = never>(
    onRejected?: ((reason: unknown) => Result | PromiseLike<Result>) | null
  ): Promise<Output | Result>;
  finally(onFinally?: (() => void) | null): Promise<Output>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface NormalizedRetry {
  retries: number;
  backoff: BackoffStrategy | undefined;
  when: RetryOptions["when"] | undefined;
}

interface ThrottleState {
  tokens: number;
  updatedAt: number;
}

interface DebounceState {
  job: InternalJob;
  until: number;
  mode: "leading" | "trailing";
}

interface InternalJob {
  id: string;
  name: string;
  input: unknown;
  status: JobStatus;
  priority: number;
  attempt: number;
  retry: NormalizedRetry;
  timeout: number | undefined;
  key: string | undefined;
  keyRetention: number;
  keyExpiresAt: number | undefined;
  concurrency: KeyedConcurrencyOptions | undefined;
  throttle: ThrottleOptions | undefined;
  debounceKey: string | undefined;
  createdAt: number;
  runAt: number;
  expiresAt: number | undefined;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  progress: unknown;
  output: unknown;
  error: SerializedError | undefined;
  errorCause: Error | undefined;
  logs: JobLogEntry[];
  sequence: number;
  controller: AbortController | undefined;
  completion: Deferred<JobSnapshot>;
  externalSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

class JobHandle<Output, Input, Name extends string>
  implements Job<Output, Input, Name>
{
  constructor(
    private readonly owner: MemoryQueue<JobMap>,
    private readonly job: InternalJob,
    readonly deduplicated: boolean
  ) {}

  get id(): string {
    return this.job.id;
  }

  get name(): Name {
    return this.job.name as Name;
  }

  get input(): Input {
    return this.job.input as Input;
  }

  get status(): JobStatus {
    return this.job.status;
  }

  get result(): Promise<Output> {
    return this.owner.resultFor(this.job) as Promise<Output>;
  }

  get accepted(): Promise<void> {
    return Promise.resolve();
  }

  cancel(reason?: string): boolean {
    return this.owner.cancel(this.id, reason);
  }

  snapshot(): JobSnapshot<Input, Output, Name> {
    return snapshot(this.job) as JobSnapshot<Input, Output, Name>;
  }

  then<Result1 = Output, Result2 = never>(
    onFulfilled?:
      | ((value: Output) => Result1 | PromiseLike<Result1>)
      | null,
    onRejected?:
      | ((reason: unknown) => Result2 | PromiseLike<Result2>)
      | null
  ): PromiseLike<Result1 | Result2> {
    return this.result.then(onFulfilled, onRejected);
  }

  catch<Result = never>(
    onRejected?: ((reason: unknown) => Result | PromiseLike<Result>) | null
  ): Promise<Output | Result> {
    return this.result.catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<Output> {
    return this.result.finally(onFinally ?? undefined);
  }
}

/**
 * A zero-dependency, single-process job queue with strongly typed named jobs.
 *
 * State is intentionally kept in memory. MemoryQueue is ideal for local background
 * work, concurrency control, API throttling, and tests. It is not durable or
 * distributed; use a database-backed queue when jobs must survive restarts.
 */
export class MemoryQueue<Jobs extends JobMap> {
  readonly name: string;

  private readonly handlers: Jobs;
  private readonly records = new Map<string, InternalJob>();
  private readonly keys = new Map<string, InternalJob>();
  private readonly activeKeys = new Map<string, number>();
  private readonly throttleStates = new Map<string, ThrottleState>();
  private readonly debounceStates = new Map<string, DebounceState>();
  private readonly ready = new BinaryHeap<InternalJob>(readyBefore);
  private readonly delayed = new BinaryHeap<InternalJob>(delayedBefore);
  private readonly listeners = new Map<
    keyof QueueEventMap,
    Set<(payload: never) => void>
  >();
  private readonly defaultRetry: NormalizedRetry;
  private readonly defaultTimeout: number | undefined;
  private readonly rateLimit: RateLimitOptions | undefined;
  private readonly historyLimit: number;
  private readonly logLimit: number;
  private readonly starts: number[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly sizeWaiters = new Set<{
    limit: number;
    resolve(): void;
  }>();

  private _concurrency: number;
  private runningCount = 0;
  private sequence = 0;
  private started: boolean;
  private closed = false;
  private idleNotified = true;
  private pumpQueued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private policyWakeAt: number | undefined;

  constructor(handlers: Jobs, options: QueueOptions = {}) {
    if (Object.keys(handlers).length === 0) {
      throw new TypeError("At least one job handler is required");
    }

    this.name = options.name?.trim() || "default";
    this._concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;
    this.defaultRetry = normalizeRetry(options.retry);
    this.defaultTimeout = options.timeout;
    this.rateLimit = options.rateLimit;
    this.historyLimit = options.historyLimit ?? 1000;
    this.logLimit = options.logLimit ?? 100;
    this.started = options.autoStart ?? true;
    this.handlers = handlers;

    validatePositiveIntegerOrInfinity("concurrency", this._concurrency);
    validateTimeout(this.defaultTimeout);
    validateNonNegativeInteger("historyLimit", this.historyLimit);
    validateNonNegativeInteger("logLimit", this.logLimit);
    if (this.rateLimit) {
      validatePositiveInteger("rateLimit.limit", this.rateLimit.limit);
      validatePositiveNumber("rateLimit.interval", this.rateLimit.interval);
    }
  }

  get concurrency(): number {
    return this._concurrency;
  }

  set concurrency(value: number) {
    validatePositiveIntegerOrInfinity("concurrency", value);
    this._concurrency = value;
    this.requestPump();
  }

  /** Jobs waiting to start, including scheduled jobs. */
  get size(): number {
    let count = 0;
    for (const job of this.records.values()) {
      if (job.status === "queued" || job.status === "scheduled") {
        count += 1;
      }
    }
    return count;
  }

  /** Jobs currently running. */
  get pending(): number {
    return this.runningCount;
  }

  get isPaused(): boolean {
    return !this.started && !this.closed;
  }

  get isRateLimited(): boolean {
    if (!this.rateLimit || this.size === 0) {
      return false;
    }
    this.pruneStarts(Date.now());
    return this.starts.length >= this.rateLimit.limit;
  }

  get isSaturated(): boolean {
    return (
      this.size > 0 &&
      (this.runningCount >= this._concurrency || this.isRateLimited)
    );
  }

  get stats(): QueueStats {
    const value: QueueStats = {
      queued: 0,
      scheduled: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      expired: 0,
      total: 0,
    };
    for (const job of this.records.values()) {
      value[job.status] += 1;
      value.total += 1;
    }
    return value;
  }

  add<Name extends JobName<Jobs>>(
    name: Name,
    input: JobInput<Jobs, Name>,
    options: AddOptions = {}
  ): Job<JobOutput<Jobs, Name>, JobInput<Jobs, Name>, Name> {
    this.assertOpen();

    const handler = this.handlers[name];
    if (typeof handler !== "function") {
      throw new TypeError(`Unknown job "${name}"`);
    }

    const now = Date.now();
    this.prunePolicyState(now);
    validateExecutionOptions(options);

    const key = options.key ? `${String(name)}:${options.key}` : undefined;
    if (key) {
      const existing = this.keys.get(key);
      if (existing) {
        if (
          !isTerminal(existing.status) ||
          (existing.keyExpiresAt !== undefined &&
            existing.keyExpiresAt > now)
        ) {
          return this.handle(existing, true);
        }
        this.keys.delete(key);
      }
    }

    const debounceKey = options.debounce
      ? `${String(name)}:${options.debounce.key}`
      : undefined;
    const debounceState = debounceKey
      ? this.debounceStates.get(debounceKey)
      : undefined;
    if (debounceState && options.debounce) {
      if (
        options.debounce.mode === "leading" &&
        debounceState.until > now
      ) {
        return this.handle(debounceState.job, true);
      }
      if (
        options.debounce.mode === "trailing" &&
        (debounceState.job.status === "queued" ||
          debounceState.job.status === "scheduled")
      ) {
        this.updateTrailingDebounce(
          debounceState,
          input,
          options,
          now
        );
        return this.handle(debounceState.job, true);
      }
    }

    const id = options.id ?? this.createId(String(name), now);
    if (!id) {
      throw new TypeError("Job ID must not be empty");
    }
    if (this.records.has(id)) {
      throw new Error(`Job ID "${id}" already exists`);
    }

    const requestedRunAt = normalizeRunAt(options.delay, now);
    const runAt =
      options.debounce?.mode === "trailing"
        ? Math.max(requestedRunAt, now + options.debounce.wait)
        : requestedRunAt;
    const priority = options.priority ?? 0;
    const retry =
      options.retry === undefined
        ? this.defaultRetry
        : normalizeRetry(options.retry);
    const timeout = options.timeout ?? this.defaultTimeout;
    const expiresAt =
      options.expiresIn === undefined ? undefined : now + options.expiresIn;

    if (!Number.isFinite(priority)) {
      throw new RangeError("priority must be a finite number");
    }
    validateTimeout(timeout);
    if (options.expiresIn !== undefined) {
      validatePositiveNumber("expiresIn", options.expiresIn);
    }

    const job: InternalJob = {
      id,
      name: String(name),
      input,
      status: runAt > now ? "scheduled" : "queued",
      priority,
      attempt: 0,
      retry,
      timeout,
      key,
      keyRetention: options.keyRetention ?? 0,
      keyExpiresAt: undefined,
      concurrency: options.concurrency,
      throttle: options.throttle,
      debounceKey,
      createdAt: now,
      runAt,
      expiresAt,
      startedAt: undefined,
      finishedAt: undefined,
      progress: undefined,
      output: undefined,
      error: undefined,
      errorCause: undefined,
      logs: [],
      sequence: this.sequence++,
      controller: undefined,
      completion: deferred<JobSnapshot>(),
      externalSignal: options.signal,
      abortListener: undefined,
    };

    this.records.set(id, job);
    this.idleNotified = false;
    if (key) {
      this.keys.set(key, job);
    }
    if (debounceKey && options.debounce) {
      this.debounceStates.set(debounceKey, {
        job,
        until: now + options.debounce.wait,
        mode: options.debounce.mode,
      });
    }
    if (job.status === "scheduled") {
      this.delayed.push(job);
    } else {
      this.ready.push(job);
    }
    this.emit("added", snapshot(job));
    this.connectSignal(job);
    this.notifySizeWaiters();
    this.requestPump();
    return this.handle(job, false);
  }

  private updateTrailingDebounce(
    state: DebounceState,
    input: unknown,
    options: AddOptions,
    now: number
  ): void {
    const job = state.job;
    this.ready.remove(job);
    this.delayed.remove(job);
    this.disconnectSignal(job);

    job.input = input;
    job.status = "scheduled";
    job.priority = options.priority ?? job.priority;
    job.retry =
      options.retry === undefined
        ? job.retry
        : normalizeRetry(options.retry);
    job.timeout = options.timeout ?? job.timeout;
    job.runAt = Math.max(
      normalizeRunAt(options.delay, now),
      now + (options.debounce?.wait ?? 0)
    );
    job.expiresAt =
      options.expiresIn === undefined ? undefined : now + options.expiresIn;
    job.concurrency = options.concurrency;
    job.throttle = options.throttle;
    job.sequence = this.sequence++;
    job.externalSignal = options.signal;
    state.until = now + (options.debounce?.wait ?? 0);
    this.delayed.push(job);
    this.connectSignal(job);
    this.emit("added", snapshot(job));
    this.requestPump();
  }

  addMany<Name extends JobName<Jobs>>(
    name: Name,
    inputs: readonly JobInput<Jobs, Name>[],
    options?: AddOptions
  ): Array<Job<JobOutput<Jobs, Name>, JobInput<Jobs, Name>, Name>> {
    return inputs.map((input) => this.add(name, input, options));
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.records.get(id);
    return job ? snapshot(job) : undefined;
  }

  list(status?: JobStatus): JobSnapshot[] {
    const jobs: JobSnapshot[] = [];
    for (const job of this.records.values()) {
      if (!status || job.status === status) {
        jobs.push(snapshot(job));
      }
    }
    return jobs.sort((a, b) => a.createdAt - b.createdAt);
  }

  cancel(id: string, reason = "Job was cancelled"): boolean {
    const job = this.records.get(id);
    if (!job || isTerminal(job.status)) {
      return false;
    }

    const error = new JobCancelledError(id, reason);
    job.status = "cancelled";
    job.finishedAt = Date.now();
    job.error = serializeError(error);
    job.errorCause = error;
    job.controller?.abort(error);
    this.finish(job, "cancelled");
    this.notifySizeWaiters();
    this.requestPump();
    return true;
  }

  clear(reason = "Queue was cleared"): number {
    let count = 0;
    for (const job of this.records.values()) {
      if (
        (job.status === "queued" || job.status === "scheduled") &&
        this.cancel(job.id, reason)
      ) {
        count += 1;
      }
    }
    return count;
  }

  retry(id: string): Job<unknown> | undefined {
    this.assertOpen();
    const job = this.records.get(id);
    if (
      !job ||
      (job.status !== "failed" &&
        job.status !== "cancelled" &&
        job.status !== "expired")
    ) {
      return undefined;
    }

    job.status = "queued";
    job.attempt = 0;
    job.runAt = Date.now();
    job.expiresAt = undefined;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    job.progress = undefined;
    job.output = undefined;
    job.error = undefined;
    job.errorCause = undefined;
    job.logs = [];
    job.sequence = this.sequence++;
    job.controller = undefined;
    job.completion = deferred<JobSnapshot>();
    this.idleNotified = false;
    if (job.key) {
      this.keys.set(job.key, job);
    }
    this.ready.push(job);
    this.connectSignal(job);
    this.notifySizeWaiters();
    this.requestPump();
    return this.handle(job, false);
  }

  pause(): this {
    this.assertOpen();
    this.started = false;
    this.clearTimer();
    return this;
  }

  start(): this {
    this.assertOpen();
    this.started = true;
    this.requestPump();
    return this;
  }

  async onIdle(): Promise<void> {
    if (this.size === 0 && this.runningCount === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  async onSizeLessThan(limit: number): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive integer");
    }
    if (this.size < limit) {
      return;
    }
    await new Promise<void>((resolve) =>
      this.sizeWaiters.add({ limit, resolve })
    );
  }

  cleanup(options: CleanupOptions = {}): string[] {
    const olderThan = options.olderThan ?? 0;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const statuses =
      options.status === undefined
        ? undefined
        : new Set<JobStatus>(
            typeof options.status === "string"
              ? [options.status]
              : options.status,
          );
    if (!Number.isFinite(olderThan) || olderThan < 0) {
      throw new RangeError("olderThan must be a non-negative finite number");
    }
    if (
      (!Number.isInteger(limit) && limit !== Number.POSITIVE_INFINITY) ||
      limit < 0
    ) {
      throw new RangeError("limit must be a non-negative integer or Infinity");
    }

    const threshold = Date.now() - olderThan;
    const removed: string[] = [];
    for (const [id, job] of this.records) {
      if (removed.length >= limit) {
        break;
      }
      if (
        !isTerminal(job.status) ||
        (statuses !== undefined && !statuses.has(job.status)) ||
        (job.finishedAt ?? Number.POSITIVE_INFINITY) > threshold
      ) {
        continue;
      }
      this.records.delete(id);
      removed.push(id);
    }
    return removed;
  }

  async close(options: CloseOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    if (options.drain ?? true) {
      this.started = true;
      this.requestPump();
      await this.onIdle();
    } else {
      this.clear("Queue closed");
      for (const job of this.records.values()) {
        if (job.status === "running") {
          this.cancel(job.id, "Queue closed");
        }
      }
      if (this.runningCount > 0) {
        await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
      }
    }

    this.started = false;
    this.closed = true;
    this.clearTimer();
  }

  on<Event extends keyof QueueEventMap>(
    event: Event,
    listener: (payload: QueueEventMap[Event]) => void
  ): () => void {
    let group = this.listeners.get(event);
    if (!group) {
      group = new Set();
      this.listeners.set(event, group);
    }
    group.add(listener as (payload: never) => void);
    return () => {
      group?.delete(listener as (payload: never) => void);
    };
  }

  /** @internal Used by the awaitable job handle. */
  async resultFor(job: InternalJob): Promise<unknown> {
    const result = isTerminal(job.status)
      ? snapshot(job)
      : await job.completion.promise;

    if (result.status === "succeeded") {
      return result.output;
    }
    if (result.status === "cancelled") {
      throw new JobCancelledError(job.id, result.error?.message);
    }
    if (result.status === "expired") {
      throw new JobExpiredError(job.id);
    }
    throw new JobFailedError(
      job.id,
      result.error?.message ?? `Job "${job.id}" failed`,
      job.errorCause ? { cause: job.errorCause } : undefined
    );
  }

  private handle<
    Output = unknown,
    Input = unknown,
    Name extends string = string,
  >(job: InternalJob, deduplicated: boolean): Job<Output, Input, Name> {
    return new JobHandle<Output, Input, Name>(
      this as unknown as MemoryQueue<JobMap>,
      job,
      deduplicated
    );
  }

  private createId(name: string, now: number): string {
    return `${this.name}:${name}:${now.toString(36)}:${this.sequence.toString(36)}`;
  }

  private connectSignal(job: InternalJob): void {
    this.disconnectSignal(job);
    const signal = job.externalSignal;
    if (!signal) {
      return;
    }
    const abort = (): void => {
      this.cancel(job.id, abortMessage(signal.reason));
    };
    job.abortListener = abort;
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }

  private disconnectSignal(job: InternalJob): void {
    if (job.externalSignal && job.abortListener) {
      job.externalSignal.removeEventListener("abort", job.abortListener);
      job.abortListener = undefined;
    }
  }

  private requestPump(): void {
    if (this.pumpQueued || !this.started || this.closed) {
      return;
    }
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (!this.started || this.closed) {
      return;
    }

    this.clearTimer();
    const now = Date.now();
    this.policyWakeAt = undefined;
    this.prunePolicyState(now);
    this.expireWaiting(now);
    this.promoteDelayed(now);
    this.pruneStarts(now);

    while (
      this.runningCount < this._concurrency &&
      this.hasRateCapacity()
    ) {
      const job = this.popReady(now);
      if (!job) {
        break;
      }
      this.beginExecutionPolicy(job, now);
      if (this.rateLimit) {
        this.starts.push(Date.now());
      }
      void this.execute(job);
    }

    this.scheduleNextWake();
    this.notifyIdle();
  }

  private promoteDelayed(now: number): void {
    while (true) {
      const job = this.peekDelayed();
      if (!job || job.runAt > now) {
        return;
      }
      this.delayed.pop();
      if (job.status === "scheduled") {
        job.status = "queued";
        this.ready.push(job);
      }
    }
  }

  private expireWaiting(now: number): void {
    for (const job of this.records.values()) {
      if (
        (job.status === "queued" || job.status === "scheduled") &&
        job.expiresAt !== undefined &&
        job.expiresAt <= now
      ) {
        const error = new JobExpiredError(job.id);
        job.status = "expired";
        job.finishedAt = now;
        job.error = serializeError(error);
        job.errorCause = error;
        this.finish(job, "expired");
      }
    }
  }

  private peekDelayed(): InternalJob | undefined {
    while (true) {
      const job = this.delayed.peek();
      if (!job || job.status === "scheduled") {
        return job;
      }
      this.delayed.pop();
    }
  }

  private popReady(now: number): InternalJob | undefined {
    const blocked: InternalJob[] = [];
    let selected: InternalJob | undefined;
    while (!selected) {
      const job = this.ready.pop();
      if (!job) {
        break;
      }
      if (job.status !== "queued") {
        continue;
      }
      if (this.canStart(job, now)) {
        selected = job;
        break;
      }
      blocked.push(job);
    }
    for (const job of blocked) {
      this.ready.push(job);
    }
    return selected;
  }

  private canStart(job: InternalJob, now: number): boolean {
    if (job.concurrency) {
      const active = this.activeKeys.get(job.concurrency.key) ?? 0;
      if (active >= job.concurrency.limit) {
        return false;
      }
    }
    if (job.throttle) {
      const state = this.refillThrottle(job.throttle, now);
      if (state.tokens < 1) {
        const refillPerMs =
          job.throttle.limit / job.throttle.interval;
        const wakeAt = now + Math.ceil((1 - state.tokens) / refillPerMs);
        this.policyWakeAt =
          this.policyWakeAt === undefined
            ? wakeAt
            : Math.min(this.policyWakeAt, wakeAt);
        return false;
      }
    }
    return true;
  }

  private beginExecutionPolicy(job: InternalJob, now: number): void {
    if (job.concurrency) {
      this.activeKeys.set(
        job.concurrency.key,
        (this.activeKeys.get(job.concurrency.key) ?? 0) + 1
      );
    }
    if (job.throttle) {
      const state = this.refillThrottle(job.throttle, now);
      state.tokens = Math.max(0, state.tokens - 1);
    }
  }

  private releaseExecutionPolicy(job: InternalJob): void {
    if (!job.concurrency) {
      return;
    }
    const active = (this.activeKeys.get(job.concurrency.key) ?? 1) - 1;
    if (active <= 0) {
      this.activeKeys.delete(job.concurrency.key);
    } else {
      this.activeKeys.set(job.concurrency.key, active);
    }
  }

  private refillThrottle(
    policy: ThrottleOptions,
    now: number
  ): ThrottleState {
    let state = this.throttleStates.get(policy.key);
    if (!state) {
      state = { tokens: policy.burst, updatedAt: now };
      this.throttleStates.set(policy.key, state);
      return state;
    }
    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(
      policy.burst,
      state.tokens + elapsed * (policy.limit / policy.interval)
    );
    state.updatedAt = now;
    return state;
  }

  private hasReady(): boolean {
    while (true) {
      const job = this.ready.peek();
      if (!job) {
        return false;
      }
      if (job.status === "queued") {
        return true;
      }
      this.ready.pop();
    }
  }

  private hasRateCapacity(): boolean {
    return !this.rateLimit || this.starts.length < this.rateLimit.limit;
  }

  private pruneStarts(now: number): void {
    if (!this.rateLimit) {
      return;
    }
    const threshold = now - this.rateLimit.interval;
    while (this.starts.length > 0 && (this.starts[0] as number) <= threshold) {
      this.starts.shift();
    }
  }

  private scheduleNextWake(): void {
    let wakeAt: number | undefined;
    const delayed = this.peekDelayed();
    if (delayed) {
      wakeAt = delayed.runAt;
    }
    if (
      this.rateLimit &&
      this.hasReady() &&
      !this.hasRateCapacity() &&
      this.starts[0] !== undefined
    ) {
      const rateWake = this.starts[0] + this.rateLimit.interval;
      wakeAt = wakeAt === undefined ? rateWake : Math.min(wakeAt, rateWake);
    }
    if (this.policyWakeAt !== undefined) {
      wakeAt =
        wakeAt === undefined
          ? this.policyWakeAt
          : Math.min(wakeAt, this.policyWakeAt);
    }
    for (const job of this.records.values()) {
      if (
        (job.status === "queued" || job.status === "scheduled") &&
        job.expiresAt !== undefined
      ) {
        wakeAt =
          wakeAt === undefined
            ? job.expiresAt
            : Math.min(wakeAt, job.expiresAt);
      }
    }
    if (wakeAt === undefined || this.runningCount >= this._concurrency) {
      return;
    }

    const delay = Math.max(0, wakeAt - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.requestPump();
    }, Math.min(delay, 2_147_483_647));
  }

  private async execute(job: InternalJob): Promise<void> {
    const handler = this.handlers[job.name as JobName<Jobs>];
    if (typeof handler !== "function" || job.status !== "queued") {
      return;
    }

    job.status = "running";
    job.attempt += 1;
    job.startedAt = Date.now();
    job.controller = new AbortController();
    this.runningCount += 1;
    this.emit("started", snapshot(job));
    this.notifySizeWaiters();

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context: JobContext = {
        id: job.id,
        name: job.name,
        attempt: job.attempt,
        signal: job.controller.signal,
        progress: (value: unknown): void => {
          if (job.status === "running") {
            job.progress = value;
            this.emit("progress", snapshot(job));
          }
        },
        log: (entry: JobLogEntry): void => {
          if (job.status !== "running" || this.logLimit === 0) {
            return;
          }
          job.logs.push(entry);
          if (job.logs.length > this.logLimit) {
            job.logs.splice(0, job.logs.length - this.logLimit);
          }
          this.emit("log", { job: snapshot(job), entry });
        },
      };
      const execution = Promise.resolve(handler(job.input, context));
      const output =
        job.timeout === undefined
          ? await execution
          : await Promise.race([
              execution,
              new Promise<never>((_, reject) => {
                timeoutTimer = setTimeout(() => {
                  const error = new JobTimeoutError(
                    job.id,
                    job.timeout as number
                  );
                  job.controller?.abort(error);
                  reject(error);
                }, job.timeout);
              }),
            ]);

      if (!isCancelled(job)) {
        job.status = "succeeded";
        job.output = output;
        job.error = undefined;
        job.errorCause = undefined;
        job.finishedAt = Date.now();
        this.finish(job, "succeeded");
      }
    } catch (cause) {
      if (!isCancelled(job)) {
        try {
          await this.handleFailure(job, toError(cause));
        } catch (policyCause) {
          const policyError = toError(policyCause);
          job.error = serializeError(policyError);
          job.errorCause = policyError;
          job.status = "failed";
          job.finishedAt = Date.now();
          this.finish(job, "failed");
        }
      }
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      job.controller = undefined;
      this.releaseExecutionPolicy(job);
      this.runningCount -= 1;
      this.notifyIdle();
      this.requestPump();
    }
  }

  private async handleFailure(job: InternalJob, error: Error): Promise<void> {
    job.error = serializeError(error);
    job.errorCause = error;

    const shouldRetry =
      job.attempt <= job.retry.retries &&
      (job.retry.when ? await job.retry.when(error, job.attempt) : true);

    if (!shouldRetry) {
      job.status = "failed";
      job.finishedAt = Date.now();
      this.finish(job, "failed");
      return;
    }

    const delay = await backoffDelay(job.retry.backoff, job.attempt, error);
    job.runAt = Date.now() + delay;
    job.sequence = this.sequence++;
    job.status = delay > 0 ? "scheduled" : "queued";
    if (job.status === "scheduled") {
      this.delayed.push(job);
    } else {
      this.ready.push(job);
    }
    this.emit("retry", { job: snapshot(job), error, delay });
  }

  private finish(
    job: InternalJob,
    event: "succeeded" | "failed" | "cancelled" | "expired"
  ): void {
    this.disconnectSignal(job);
    if (job.key && this.keys.get(job.key) === job) {
      if (job.keyRetention > 0) {
        job.keyExpiresAt = Date.now() + job.keyRetention;
      } else {
        this.keys.delete(job.key);
      }
    }
    const value = snapshot(job);
    job.completion.resolve(value);
    this.emit(event, value);
    this.pruneHistory();
    this.notifyIdle();
  }

  private pruneHistory(): void {
    let finished = 0;
    for (const job of this.records.values()) {
      if (isTerminal(job.status)) {
        finished += 1;
      }
    }
    let remove = finished - this.historyLimit;
    if (remove <= 0) {
      return;
    }
    for (const [id, job] of this.records) {
      if (remove <= 0) {
        return;
      }
      if (isTerminal(job.status)) {
        if (job.key && this.keys.get(job.key) === job) {
          this.keys.delete(job.key);
        }
        this.records.delete(id);
        remove -= 1;
      }
    }
  }

  private prunePolicyState(now: number): void {
    for (const [key, job] of this.keys) {
      if (
        isTerminal(job.status) &&
        (job.keyExpiresAt === undefined || job.keyExpiresAt <= now)
      ) {
        this.keys.delete(key);
      }
    }
    for (const [key, state] of this.debounceStates) {
      if (
        state.until <= now &&
        (state.mode === "leading" || isTerminal(state.job.status))
      ) {
        this.debounceStates.delete(key);
      }
    }
  }

  private notifyIdle(): void {
    if (this.size !== 0 || this.runningCount !== 0) {
      this.idleNotified = false;
      return;
    }
    for (const resolve of this.idleWaiters) {
      resolve();
    }
    this.idleWaiters.clear();
    if (!this.idleNotified) {
      this.idleNotified = true;
      this.emit("idle", this.stats);
    }
  }

  private notifySizeWaiters(): void {
    const size = this.size;
    for (const waiter of this.sizeWaiters) {
      if (size < waiter.limit) {
        waiter.resolve();
        this.sizeWaiters.delete(waiter);
      }
    }
  }

  private emit<Event extends keyof QueueEventMap>(
    event: Event,
    payload: QueueEventMap[Event]
  ): void {
    const group = this.listeners.get(event);
    if (!group) {
      return;
    }
    for (const listener of group) {
      try {
        listener(payload as never);
      } catch {
        // Observers cannot break queue processing.
      }
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new QueueClosedError(this.name);
    }
  }
}

/** Create a strongly typed queue from a map of named handlers. */
export function memoryQueue<const Jobs extends JobMap>(
  handlers: Jobs,
  options?: QueueOptions
): MemoryQueue<Jobs> {
  return new MemoryQueue(handlers, options);
}

class BinaryHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly before: (left: T, right: T) => boolean) {}

  peek(): T | undefined {
    return this.values[0];
  }

  push(value: T): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.before(value, this.values[parent] as T)) {
        break;
      }
      this.values[index] = this.values[parent] as T;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): T | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (first === undefined || last === undefined || this.values.length === 0) {
      return first;
    }

    let index = 0;
    this.values[0] = last;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (
        left < this.values.length &&
        this.before(this.values[left] as T, this.values[next] as T)
      ) {
        next = left;
      }
      if (
        right < this.values.length &&
        this.before(this.values[right] as T, this.values[next] as T)
      ) {
        next = right;
      }
      if (next === index) {
        break;
      }
      [this.values[index], this.values[next]] = [
        this.values[next] as T,
        this.values[index] as T,
      ];
      index = next;
    }
    return first;
  }

  remove(value: T): void {
    const filtered = this.values.filter((entry) => entry !== value);
    if (filtered.length === this.values.length) {
      return;
    }
    this.values.length = 0;
    for (const entry of filtered) {
      this.push(entry);
    }
  }
}

function readyBefore(left: InternalJob, right: InternalJob): boolean {
  return (
    left.priority > right.priority ||
    (left.priority === right.priority && left.sequence < right.sequence)
  );
}

function delayedBefore(left: InternalJob, right: InternalJob): boolean {
  return (
    left.runAt < right.runAt ||
    (left.runAt === right.runAt && readyBefore(left, right))
  );
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      resolvePromise?.(value);
    },
  };
}

function snapshot(job: InternalJob): JobSnapshot {
  return {
    id: job.id,
    name: job.name,
    input: job.input,
    status: job.status,
    priority: job.priority,
    attempt: job.attempt,
    retries: job.retry.retries,
    createdAt: job.createdAt,
    runAt: job.runAt,
    expiresAt: job.expiresAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    output: job.output,
    error: job.error,
    logs: [...job.logs],
  };
}

function normalizeRetry(
  retry: number | RetryOptions | undefined
): NormalizedRetry {
  if (retry === undefined) {
    return { retries: 0, backoff: undefined, when: undefined };
  }
  if (typeof retry === "number") {
    validateNonNegativeInteger("retry", retry);
    return { retries: retry, backoff: undefined, when: undefined };
  }
  validateNonNegativeInteger("retry.retries", retry.retries);
  return {
    retries: retry.retries,
    backoff: retry.backoff,
    when: retry.when,
  };
}

async function backoffDelay(
  strategy: BackoffStrategy | undefined,
  attempt: number,
  error: Error
): Promise<number> {
  if (strategy === undefined) {
    return 0;
  }
  if (typeof strategy === "function") {
    return normalizeBackoff(await strategy(attempt, error));
  }
  if (typeof strategy === "number") {
    return normalizeBackoff(strategy);
  }

  const base =
    strategy.type === "exponential"
      ? strategy.delay * 2 ** Math.max(0, attempt - 1)
      : strategy.delay;
  const jitter = Math.min(1, Math.max(0, strategy.jitter ?? 0));
  return normalizeBackoff(base * (1 - Math.random() * jitter));
}

function normalizeBackoff(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("backoff delay must be a non-negative finite number");
  }
  return value;
}

function normalizeRunAt(delay: number | Date | undefined, now: number): number {
  if (delay instanceof Date) {
    const value = delay.getTime();
    if (!Number.isFinite(value)) {
      throw new RangeError("delay date must be valid");
    }
    return Math.max(now, value);
  }
  if (delay === undefined) {
    return now;
  }
  if (!Number.isFinite(delay) || delay < 0) {
    throw new RangeError("delay must be a non-negative finite number");
  }
  return now + delay;
}

function validateTimeout(value: number | undefined): void {
  if (value !== undefined) {
    validatePositiveNumber("timeout", value);
  }
}

function validateExecutionOptions(options: AddOptions): void {
  if (options.keyRetention !== undefined) {
    if (!Number.isFinite(options.keyRetention) || options.keyRetention < 0) {
      throw new RangeError(
        "keyRetention must be a non-negative finite number"
      );
    }
  }
  if (options.concurrency) {
    validatePositiveInteger(
      "concurrency.limit",
      options.concurrency.limit
    );
    validatePolicyKey("concurrency.key", options.concurrency.key);
  }
  if (options.throttle) {
    validatePositiveInteger("throttle.limit", options.throttle.limit);
    validatePositiveNumber("throttle.interval", options.throttle.interval);
    validatePositiveInteger("throttle.burst", options.throttle.burst);
    validatePolicyKey("throttle.key", options.throttle.key);
  }
  if (options.debounce) {
    validatePositiveNumber("debounce.wait", options.debounce.wait);
    validatePolicyKey("debounce.key", options.debounce.key);
  }
}

function validatePolicyKey(name: string, value: string): void {
  if (!value.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function validatePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function validateNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function validatePositiveNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function validatePositiveIntegerOrInfinity(
  name: string,
  value: number
): void {
  if (value !== Number.POSITIVE_INFINITY) {
    validatePositiveInteger(name, value);
  }
}

function isTerminal(status: JobStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

function isCancelled(job: InternalJob): boolean {
  return job.status === "cancelled";
}

function serializeError(error: Error): SerializedError {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function abortMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return reason === undefined ? "Job was aborted" : String(reason);
}
