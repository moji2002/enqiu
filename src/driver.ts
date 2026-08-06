/**
 * The seam between the public `enqiu()` facade and a storage backend.
 *
 * This module is types only. It never imports a driver implementation, which
 * is what keeps the Redis driver — and the ~30KB of Lua it carries — out of
 * bundles that only ever use the in-memory driver.
 */

import type {
  AddOptions,
  JobHandler,
  JobSnapshot,
  JobStatus,
  QueueEventMap,
  QueueStats,
  RetryOptions,
} from "./memory.js";

export type DriverHandlers = Record<string, JobHandler<unknown, unknown>>;

export interface DriverQueueOptions {
  name?: string;
  concurrency?: number;
  autoStart?: boolean;
  /** Whether this process should run handlers, or only submit work. */
  worker?: boolean;
  retry?: number | RetryOptions;
  timeout?: number;
  historyLimit?: number;
  logLimit?: number;
}

export interface DriverListQuery {
  status?: JobStatus;
  name?: string;
  before?: number;
  after?: number;
  limit?: number;
  cursor?: string;
}

export interface DriverListPage {
  jobs: JobSnapshot[];
  cursor?: string;
}

export interface DriverCleanupQuery {
  status?: JobStatus | readonly JobStatus[];
  olderThan?: number;
  limit?: number;
}

export interface ScheduleSnapshot {
  id: string;
  jobName: string;
  cron: string;
  timezone: string;
  status: "active" | "paused";
  nextRunAt: number;
  input: unknown;
  catchUp: boolean;
}

export interface ScheduleHandle {
  readonly id: string;
  readonly nextRunAt: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  remove(): Promise<void>;
  refresh(): Promise<ScheduleSnapshot>;
}

export interface DriverScheduleRegistration {
  id?: string | undefined;
  jobName: string;
  cron: string;
  timezone?: string | undefined;
  input: unknown;
  catchUp?: boolean | undefined;
  /** Options applied to each occurrence this schedule submits. */
  submit: AddOptions;
}

/** A submitted job, however the driver represents it internally. */
export interface DriverJob {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: JobStatus;
  readonly deduplicated: boolean;
  /**
   * Resolves once the driver has durably accepted the job. The in-memory
   * driver accepts synchronously; Redis resolves after the enqueue script runs.
   */
  readonly accepted: Promise<void>;
  readonly result: Promise<unknown>;
  cancel(reason?: string): Promise<boolean>;
  snapshot(): Promise<JobSnapshot>;
}

/**
 * Everything the facade needs from a backend. Implementations are free to be
 * synchronous internally; the facade always awaits.
 */
export interface QueueDriver {
  add(name: string, input: unknown, options: AddOptions): DriverJob;
  get(id: string): Promise<JobSnapshot | undefined>;
  list(query: DriverListQuery): Promise<DriverListPage>;
  stats(): Promise<QueueStats>;
  redrive(id: string): Promise<DriverJob>;
  cleanup(query: DriverCleanupQuery): Promise<string[]>;
  upsertSchedule(
    registration: DriverScheduleRegistration
  ): Promise<ScheduleHandle>;

  /**
   * Queue-wide admin. On a shared backend these affect every process, not
   * just this one, which is why they are distinct from the worker controls.
   */
  pauseQueue(): Promise<void>;
  resumeQueue(): Promise<void>;
  setQueueConcurrency(limit: number): Promise<void>;

  /** Controls only the handler loop inside this process. */
  startWorker(concurrency?: number): Promise<void>;
  pauseWorker(): Promise<void>;

  onIdle(): Promise<void>;
  close(options?: { drain?: boolean }): Promise<void>;
  on<Event extends keyof QueueEventMap>(
    event: Event,
    listener: (payload: QueueEventMap[Event]) => void
  ): () => void;
}

/**
 * What a driver package hands to `enqiu()`. Holding the constructor here is
 * what lets the facade stay free of any import edge to a specific backend.
 */
export interface DriverFactory {
  readonly kind: string;
  createQueue(
    handlers: DriverHandlers,
    options: DriverQueueOptions
  ): QueueDriver;
}
