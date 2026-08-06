/** Presents RedisQueue through the driver contract the facade consumes. */

import { compact } from "../internal/object.js";
import { RedisQueue } from "./queue.js";
import type {
  AddOptions,
  JobSnapshot,
  JobStatus,
  QueueEventMap,
  QueueStats,
} from "../memory.js";
import type {
  DriverCleanupQuery,
  DriverHandlers,
  DriverJob,
  DriverListPage,
  DriverListQuery,
  DriverQueueOptions,
  DriverScheduleRegistration,
  QueueDriver,
  ScheduleHandle,
} from "../driver.js";
import type {
  RedisAddOptions,
  RedisDriverConfig,
  RedisJob,
  RedisQueueOptions,
} from "./types.js";

class RedisDriverJob implements DriverJob {
  constructor(private readonly job: RedisJob) {}

  get id(): string {
    return this.job.id;
  }

  get name(): string {
    return this.job.name;
  }

  get input(): unknown {
    return this.job.input;
  }

  get status(): JobStatus {
    return this.job.status;
  }

  get deduplicated(): boolean {
    return this.job.deduplicated;
  }

  get accepted(): Promise<void> {
    return this.job.accepted;
  }

  get result(): Promise<unknown> {
    return this.job.result;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.job.cancel(reason);
  }

  snapshot(): Promise<JobSnapshot> {
    return this.job.refresh();
  }
}

export class RedisDriverAdapter implements QueueDriver {
  private readonly queue: RedisQueue<DriverHandlers>;

  constructor(
    handlers: DriverHandlers,
    config: RedisDriverConfig,
    options: DriverQueueOptions
  ) {
    this.queue = new RedisQueue(
      handlers,
      compact({
        driver: config,
        name: options.name,
        worker: options.worker,
        concurrency: options.concurrency,
        autoStart: options.autoStart,
        // `when` predicates cannot cross a process boundary, so the Redis
        // driver accepts only the serializable part of a retry policy.
        retry: options.retry as RedisQueueOptions["retry"],
        timeout: options.timeout,
        historyLimit: options.historyLimit,
        logLimit: options.logLimit,
      })
    );
  }

  add(name: string, input: unknown, options: AddOptions): DriverJob {
    return new RedisDriverJob(
      this.queue.add(name, input, options as RedisAddOptions)
    );
  }

  get(id: string): Promise<JobSnapshot | undefined> {
    return this.queue.get(id);
  }

  list(query: DriverListQuery): Promise<DriverListPage> {
    return this.queue.list(query);
  }

  stats(): Promise<QueueStats> {
    return this.queue.stats();
  }

  async redrive(id: string): Promise<DriverJob> {
    return new RedisDriverJob(await this.queue.redrive(id));
  }

  cleanup(query: DriverCleanupQuery): Promise<string[]> {
    return this.queue.cleanup(query);
  }

  upsertSchedule(
    registration: DriverScheduleRegistration
  ): Promise<ScheduleHandle> {
    return this.queue.upsertSchedule({
      ...registration,
      submit: registration.submit as RedisAddOptions,
    });
  }

  pauseQueue(): Promise<void> {
    return this.queue.pauseQueue();
  }

  resumeQueue(): Promise<void> {
    return this.queue.resumeQueue();
  }

  setQueueConcurrency(limit: number): Promise<void> {
    return this.queue.setGlobalConcurrency(limit);
  }

  async startWorker(concurrency?: number): Promise<void> {
    if (concurrency !== undefined) {
      this.queue.setWorkerConcurrency(concurrency);
    }
    this.queue.start();
  }

  async pauseWorker(): Promise<void> {
    this.queue.pause();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  close(options?: { drain?: boolean }): Promise<void> {
    return this.queue.close(options);
  }

  on<Event extends keyof QueueEventMap>(
    event: Event,
    listener: (payload: QueueEventMap[Event]) => void
  ): () => void {
    return this.queue.on(event, listener);
  }
}

