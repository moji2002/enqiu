import { MemoryQueue } from "../memory.js";
import { MemoryScheduler } from "../memory-scheduler.js";
import { compact } from "../internal/object.js";
import type {
  AddOptions,
  Job as MemoryJob,
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

/** Presents a synchronous in-memory job through the async driver contract. */
class MemoryDriverJob implements DriverJob {
  constructor(private readonly job: MemoryJob) {}

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

  async cancel(reason?: string): Promise<boolean> {
    return this.job.cancel(reason);
  }

  async snapshot(): Promise<JobSnapshot> {
    return this.job.snapshot();
  }
}

class MemoryDriver implements QueueDriver {
  private readonly queue: MemoryQueue<DriverHandlers>;
  private readonly scheduler = new MemoryScheduler();
  private readonly name: string;

  constructor(handlers: DriverHandlers, options: DriverQueueOptions) {
    this.name = options.name ?? "default";
    this.queue = new MemoryQueue(
      handlers,
      compact({
        name: options.name,
        concurrency: options.concurrency,
        autoStart: options.autoStart,
        retry: options.retry,
        timeout: options.timeout,
        historyLimit: options.historyLimit,
        logLimit: options.logLimit,
      })
    );
  }

  add(name: string, input: unknown, options: AddOptions): DriverJob {
    return new MemoryDriverJob(this.queue.add(name, input, options));
  }

  async get(id: string): Promise<JobSnapshot | undefined> {
    return this.queue.get(id);
  }

  async list(query: DriverListQuery): Promise<DriverListPage> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("list.limit must be an integer between 1 and 1000");
    }
    const offset =
      query.cursor === undefined ? 0 : Number.parseInt(query.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new TypeError("Invalid list cursor");
    }

    let jobs = this.queue.list(query.status);
    if (query.name !== undefined) {
      jobs = jobs.filter((job) => job.name === query.name);
    }
    if (query.after !== undefined) {
      jobs = jobs.filter((job) => job.createdAt > (query.after as number));
    }
    if (query.before !== undefined) {
      jobs = jobs.filter((job) => job.createdAt < (query.before as number));
    }

    const page = jobs.slice(offset, offset + limit);
    const next = offset + page.length;
    return next < jobs.length ? { jobs: page, cursor: String(next) } : { jobs: page };
  }

  async stats(): Promise<QueueStats> {
    return this.queue.stats;
  }

  async pauseQueue(): Promise<void> {
    this.queue.pause();
  }

  async resumeQueue(): Promise<void> {
    this.queue.start();
  }

  async setQueueConcurrency(limit: number): Promise<void> {
    this.queue.concurrency = limit;
  }

  async startWorker(concurrency?: number): Promise<void> {
    if (concurrency !== undefined) {
      this.queue.concurrency = concurrency;
    }
    this.queue.start();
  }

  async pauseWorker(): Promise<void> {
    this.queue.pause();
  }

  async redrive(id: string): Promise<DriverJob> {
    const job = this.queue.retry(id);
    if (!job) {
      throw new Error(`Job "${id}" cannot be redriven`);
    }
    return new MemoryDriverJob(job);
  }

  async cleanup(query: DriverCleanupQuery): Promise<string[]> {
    return this.queue.cleanup(
      compact({
        status: query.status,
        olderThan: query.olderThan,
        limit: query.limit,
      })
    );
  }

  async upsertSchedule(
    registration: DriverScheduleRegistration
  ): Promise<ScheduleHandle> {
    const scheduleId = registration.id?.trim() || registration.jobName;
    return this.scheduler.upsert({
      ...registration,
      enqueue: async (input: unknown, occurrence: number) => {
        // A stable per-occurrence ID makes a repeated tick a no-op rather
        // than a duplicate submission.
        const id = `${this.name}:schedule:${scheduleId}:${occurrence}`;
        this.queue.add(registration.jobName, input, {
          ...registration.submit,
          id,
        });
      },
    });
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  async close(options?: { drain?: boolean }): Promise<void> {
    await this.queue.close(options);
    this.scheduler.close();
  }

  on<Event extends keyof QueueEventMap>(
    event: Event,
    listener: (payload: QueueEventMap[Event]) => void
  ): () => void {
    return this.queue.on(event, listener);
  }
}

/** The default driver: single-process, non-durable, zero dependencies. */
export function createMemoryDriver(
  handlers: DriverHandlers,
  options: DriverQueueOptions
): QueueDriver {
  return new MemoryDriver(handlers, options);
}
