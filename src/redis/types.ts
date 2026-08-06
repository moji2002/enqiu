/** The Redis driver's public options and its internal record shapes. */

import type {
  AddOptions,
  JobLogEntry,
  JobSnapshot,
  JobStatus,
  QueueEventMap,
  QueueOptions,
} from "../memory.js";
import type { SerializedError } from "../internal/errors.js";
import type { BackoffOptions } from "../internal/timing.js";
import type {
  DriverFactory,
  DriverScheduleRegistration,
  ScheduleHandle,
  ScheduleSnapshot,
} from "../driver.js";

export interface RedisCommandClient {
  /** Bun's native RedisClient shape. */
  send?(command: string, arguments_: string[]): Promise<unknown>;
  /** node-redis and compatible clients. */
  sendCommand?(arguments_: string[]): Promise<unknown>;
}

export interface RedisDriverOptions {
  /** Redis key namespace. @default "enqiu" */
  prefix?: string;
  /** Worker polling interval in milliseconds. @default 100 */
  pollInterval?: number;
  /** Time before work owned by a dead worker is reclaimed. @default 30000 */
  visibilityTimeout?: number;
  /** Terminal job metadata retention in milliseconds. @default 604800000 */
  retention?: number;
}

/** Connection and tuning values every RedisQueue instance reads. */
export interface RedisDriverConfig {
  readonly client: RedisCommandClient;
  readonly prefix: string;
  readonly pollInterval: number;
  readonly visibilityTimeout: number;
  readonly retention: number;
}

/**
 * What `redis()` returns and `enqiu()` accepts.
 *
 * It carries its own queue constructor, so the facade depends on the
 * `DriverFactory` type rather than on this module. That missing import edge
 * is what lets a bundler drop this file — and the Lua it holds — from an
 * application that only uses the in-memory driver.
 */
export interface RedisDriver extends RedisDriverConfig, DriverFactory {
  readonly kind: "redis";
}

export interface RedisRetryOptions {
  retries: number;
  backoff?: number | BackoffOptions;
}

export interface RedisAddOptions
  extends Omit<AddOptions, "retry"> {
  retry?: number | RedisRetryOptions;
}

export interface RedisQueueOptions
  extends Omit<QueueOptions, "retry" | "historyLimit"> {
  driver: RedisDriverConfig;
  /**
   * Terminal jobs retained per status list. Must be at least 1; unlike the
   * in-memory driver, this one cannot retain nothing. @default 1000
   */
  historyLimit?: number;
  /**
   * Start a local worker for these handlers. Set `false` in producer-only
   * processes. @default true
   */
  worker?: boolean;
  retry?: number | RedisRetryOptions;
}

export interface RedisJob<
  Output = unknown,
  Input = unknown,
  Name extends string = string,
> {
  readonly id: string;
  readonly name: Name;
  readonly input: Input;
  readonly status: JobStatus;
  readonly deduplicated: boolean;
  /** Resolves after Redis atomically accepts the job. */
  readonly accepted: Promise<void>;
  readonly result: Promise<Output>;
  cancel(reason?: string): Promise<boolean>;
  refresh(): Promise<JobSnapshot<Input, Output, Name>>;
}

export interface RedisQueueEventMap extends QueueEventMap {
  error: Error;
  recovered: JobSnapshot;
}

export interface RedisListOptions {
  status?: JobStatus;
  name?: string;
  before?: number;
  after?: number;
  limit?: number;
  cursor?: string;
}

export interface RedisListPage {
  jobs: JobSnapshot[];
  cursor?: string;
}

export interface RedisScheduleRegistration
  extends Omit<DriverScheduleRegistration, "submit"> {
  /** Redis cannot carry a `when` predicate across the process boundary. */
  submit: RedisAddOptions;
}

export type RedisScheduleSnapshot = ScheduleSnapshot;
export type RedisScheduleHandle = ScheduleHandle;

export interface RedisJobRecord {
  id: string;
  name: string;
  input: unknown;
  status: JobStatus;
  priority: number;
  attempt: number;
  retry: NormalizedRedisRetry;
  timeout: number | undefined;
  expiresAt: number | undefined;
  keyRetention: number;
  concurrency: RedisAddOptions["concurrency"];
  throttle: RedisAddOptions["throttle"];
  debounce: RedisAddOptions["debounce"];
  createdAt: number;
  runAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  progress: unknown;
  output: unknown;
  error: SerializedError | undefined;
  logs: JobLogEntry[];
  deduplicated: boolean;
  submission: Promise<void>;
  submissionError: Error | undefined;
}

export interface NormalizedRedisRetry {
  retries: number;
  backoff: number | BackoffOptions | undefined;
}

export interface ClaimedJob {
  id: string;
  name: string;
  input: unknown;
  attempt: number;
  retry: NormalizedRedisRetry;
  timeout: number | undefined;
  token: string;
}
