/** The in-memory driver's public vocabulary. */

import type { BackoffOptions } from "../internal/timing.js";
import type { SerializedError } from "../internal/errors.js";

export type { BackoffOptions } from "../internal/timing.js";
export type { SerializedError } from "../internal/errors.js";

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

