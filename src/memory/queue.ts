/** The in-memory queue engine. */

import { serializeError, toError } from "../internal/errors.js";
import { backoffFromOptions, resolveRunAt } from "../internal/timing.js";
import {
  nonEmptyString,
  nonNegativeInteger,
  nonNegativeIntegerOrInfinity,
  nonNegativeNumber,
  positiveInteger,
  positiveIntegerOrInfinity,
  positiveNumber,
} from "../internal/validate.js";
import { BinaryHeap } from "./heap.js";
import { ExecutionPolicies } from "./policies.js";
import {
  DuplicateJobIdError,
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
} from "./errors.js";
import type { SerializedError } from "../internal/errors.js";
import type {
  AddOptions,
  BackoffStrategy,
  CleanupOptions,
  CloseOptions,
  Job,
  JobContext,
  JobInput,
  JobLogEntry,
  JobMap,
  JobName,
  JobOutput,
  JobSnapshot,
  JobStatus,
  KeyedConcurrencyOptions,
  QueueEventMap,
  QueueOptions,
  QueueStats,
  RateLimitOptions,
  RetryOptions,
  ThrottleOptions,
} from "./types.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface NormalizedRetry {
  retries: number;
  backoff: BackoffStrategy | undefined;
  when: RetryOptions["when"] | undefined;
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
  private readonly debounceStates = new Map<string, DebounceState>();
  private readonly policies = new ExecutionPolicies();
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
  /**
   * Live count per status. `size` and `stats` sit on the hot path — they run
   * on every add, finish and pump — so they must not scan `records`, which
   * also holds up to `historyLimit` finished jobs.
   */
  private readonly statusCounts: Record<JobStatus, number> = {
    queued: 0,
    scheduled: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
  };
  /** Waiting jobs that carry a deadline, the only ones expiry has to visit. */
  private readonly expiringJobs = new Set<InternalJob>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly sizeWaiters = new Set<{
    limit: number;
    resolve(): void;
  }>();

  private concurrencyLimit: number;
  private runningCount = 0;
  private sequence = 0;
  private started: boolean;
  private closed = false;
  private idleNotified = true;
  private pumpQueued = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(handlers: Jobs, options: QueueOptions = {}) {
    if (Object.keys(handlers).length === 0) {
      throw new TypeError("At least one job handler is required");
    }

    this.name = options.name?.trim() || "default";
    this.concurrencyLimit = options.concurrency ?? Number.POSITIVE_INFINITY;
    this.defaultRetry = normalizeRetry(options.retry);
    this.defaultTimeout = options.timeout;
    this.rateLimit = options.rateLimit;
    this.historyLimit = options.historyLimit ?? 1000;
    this.logLimit = options.logLimit ?? 100;
    this.started = options.autoStart ?? true;
    this.handlers = handlers;

    positiveIntegerOrInfinity("concurrency", this.concurrencyLimit);
    if (this.defaultTimeout !== undefined) {
      positiveNumber("timeout", this.defaultTimeout);
    }
    nonNegativeInteger("historyLimit", this.historyLimit);
    nonNegativeInteger("logLimit", this.logLimit);
    if (this.rateLimit) {
      positiveInteger("rateLimit.limit", this.rateLimit.limit);
      positiveNumber("rateLimit.interval", this.rateLimit.interval);
    }
  }

  get concurrency(): number {
    return this.concurrencyLimit;
  }

  set concurrency(value: number) {
    positiveIntegerOrInfinity("concurrency", value);
    this.concurrencyLimit = value;
    this.requestPump();
  }

  /** Jobs waiting to start, including scheduled jobs. */
  get size(): number {
    return this.statusCounts.queued + this.statusCounts.scheduled;
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
      (this.runningCount >= this.concurrencyLimit || this.isRateLimited)
    );
  }

  get stats(): QueueStats {
    return { ...this.statusCounts, total: this.records.size };
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
      throw new DuplicateJobIdError(id);
    }

    const requestedRunAt = resolveRunAt(options.delay, now);
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
    if (timeout !== undefined) {
      positiveNumber("timeout", timeout);
    }
    if (options.expiresIn !== undefined) {
      positiveNumber("expiresIn", options.expiresIn);
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
      sequence: this.nextSequence(),
      controller: undefined,
      completion: deferred<JobSnapshot>(),
      externalSignal: options.signal,
      abortListener: undefined,
    };

    this.track(job);
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
    this.setStatus(job, "scheduled");
    job.priority = options.priority ?? job.priority;
    job.retry =
      options.retry === undefined
        ? job.retry
        : normalizeRetry(options.retry);
    job.timeout = options.timeout ?? job.timeout;
    job.runAt = Math.max(
      resolveRunAt(options.delay, now),
      now + (options.debounce?.wait ?? 0)
    );
    job.expiresAt =
      options.expiresIn === undefined ? undefined : now + options.expiresIn;
    job.concurrency = options.concurrency;
    job.throttle = options.throttle;
    job.sequence = this.nextSequence();
    job.externalSignal = options.signal;
    state.until = now + (options.debounce?.wait ?? 0);
    // expiresAt was reassigned above, so re-evaluate the expiry index.
    this.syncExpiring(job);
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
    this.setStatus(job, "cancelled");
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

    this.setStatus(job, "queued");
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
    job.sequence = this.nextSequence();
    job.controller = undefined;
    job.completion = deferred<JobSnapshot>();
    this.idleNotified = false;
    if (job.key) {
      this.keys.set(job.key, job);
    }
    // The retried job cleared its deadline, so drop it from the expiry index.
    this.syncExpiring(job);
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
    positiveInteger("limit", limit);
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
    nonNegativeNumber("olderThan", olderThan);
    nonNegativeIntegerOrInfinity("limit", limit);

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
      this.untrack(job);
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

  /** Monotonic tie-breaker that keeps equal priorities in FIFO order. */
  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /** The single place a job's status changes, so the counters stay exact. */
  private setStatus(job: InternalJob, status: JobStatus): void {
    if (job.status !== status) {
      this.statusCounts[job.status] -= 1;
      this.statusCounts[status] += 1;
      job.status = status;
    }
    this.syncExpiring(job);
  }

  private track(job: InternalJob): void {
    this.records.set(job.id, job);
    this.statusCounts[job.status] += 1;
    this.syncExpiring(job);
  }

  private untrack(job: InternalJob): void {
    this.records.delete(job.id);
    this.statusCounts[job.status] -= 1;
    this.expiringJobs.delete(job);
  }

  /** Only a waiting job with a deadline can expire, so only those are indexed. */
  private syncExpiring(job: InternalJob): void {
    const waiting = job.status === "queued" || job.status === "scheduled";
    if (waiting && job.expiresAt !== undefined) {
      this.expiringJobs.add(job);
    } else {
      this.expiringJobs.delete(job);
    }
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
    this.policies.clearWake();
    this.prunePolicyState(now);
    this.expireWaiting(now);
    this.promoteDelayed(now);
    this.pruneStarts(now);

    while (
      this.runningCount < this.concurrencyLimit &&
      this.hasRateCapacity()
    ) {
      const job = this.popReady(now);
      if (!job) {
        break;
      }
      this.policies.begin(job, now);
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
        this.setStatus(job, "queued");
        this.ready.push(job);
      }
    }
  }

  private expireWaiting(now: number): void {
    // setStatus removes the job from expiringJobs as it expires. Deleting the
    // current entry mid-iteration is well defined for a Set.
    for (const job of this.expiringJobs) {
      if ((job.expiresAt as number) <= now) {
        const error = new JobExpiredError(job.id);
        job.finishedAt = now;
        job.error = serializeError(error);
        job.errorCause = error;
        this.setStatus(job, "expired");
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
      if (this.policies.canStart(job, now)) {
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
    const policyWakeAt = this.policies.nextWakeAt;
    if (policyWakeAt !== undefined) {
      wakeAt = wakeAt === undefined ? policyWakeAt : Math.min(wakeAt, policyWakeAt);
    }
    for (const job of this.expiringJobs) {
      const expiresAt = job.expiresAt as number;
      wakeAt = wakeAt === undefined ? expiresAt : Math.min(wakeAt, expiresAt);
    }
    if (wakeAt === undefined || this.runningCount >= this.concurrencyLimit) {
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

    this.setStatus(job, "running");
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
        this.setStatus(job, "succeeded");
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
          this.setStatus(job, "failed");
          job.finishedAt = Date.now();
          this.finish(job, "failed");
        }
      }
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      job.controller = undefined;
      this.policies.release(job);
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
      this.setStatus(job, "failed");
      job.finishedAt = Date.now();
      this.finish(job, "failed");
      return;
    }

    const delay = await backoffDelay(job.retry.backoff, job.attempt, error);
    job.runAt = Date.now() + delay;
    job.sequence = this.nextSequence();
    this.setStatus(job, delay > 0 ? "scheduled" : "queued");
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
    let remove = this.finishedCount() - this.historyLimit;
    if (remove <= 0) {
      return;
    }
    for (const job of this.records.values()) {
      if (remove <= 0) {
        return;
      }
      if (isTerminal(job.status)) {
        if (job.key && this.keys.get(job.key) === job) {
          this.keys.delete(job.key);
        }
        this.untrack(job);
        remove -= 1;
      }
    }
  }

  private finishedCount(): number {
    return (
      this.statusCounts.succeeded +
      this.statusCounts.failed +
      this.statusCounts.cancelled +
      this.statusCounts.expired
    );
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
    nonNegativeInteger("retry", retry);
    return { retries: retry, backoff: undefined, when: undefined };
  }
  nonNegativeInteger("retry.retries", retry.retries);
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
    const delay = await strategy(attempt, error);
    nonNegativeNumber("backoff delay", delay);
    return delay;
  }
  if (typeof strategy === "number") {
    nonNegativeNumber("backoff delay", strategy);
    return strategy;
  }
  return backoffFromOptions(strategy, attempt);
}

function validateExecutionOptions(options: AddOptions): void {
  if (options.keyRetention !== undefined) {
    nonNegativeNumber("keyRetention", options.keyRetention);
  }
  if (options.concurrency) {
    positiveInteger("concurrency.limit", options.concurrency.limit);
    nonEmptyString("concurrency.key", options.concurrency.key);
  }
  if (options.throttle) {
    positiveInteger("throttle.limit", options.throttle.limit);
    positiveNumber("throttle.interval", options.throttle.interval);
    positiveInteger("throttle.burst", options.throttle.burst);
    nonEmptyString("throttle.key", options.throttle.key);
  }
  if (options.debounce) {
    positiveNumber("debounce.wait", options.debounce.wait);
    nonEmptyString("debounce.key", options.debounce.key);
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

function abortMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return reason === undefined ? "Job was aborted" : String(reason);
}
