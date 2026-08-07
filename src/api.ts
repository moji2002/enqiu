/**
 * `enqiu()` — a typed layer over BullMQ.
 *
 * Enqiu owns the developer experience: inferred job names, schema-validated
 * input, and one object per job that you call like a function. BullMQ owns
 * storage, scheduling and execution. Anything BullMQ's open-source tier cannot
 * express is absent rather than faked, with two exceptions Enqiu enforces
 * itself around the handler because they cost nothing to add: `timeout` and
 * `expiresIn`.
 *
 * This file composes; the parts it composes live next to it.
 */

import { Queue, Worker, type Job as BullJob, type JobState } from "bullmq";
import { normalizeDefinition, validateInput } from "./definition.js";
import type { RuntimeDefinition } from "./definition.js";
import { QueueEventStream } from "./events.js";
import { CancellationMarkers } from "./markers.js";
import { JobRunner } from "./runner.js";
import { assertJobValue } from "./serialize.js";
import {
  JobCancelledError,
  JobFailedError,
  QueueClosedError,
  decodeFailure,
  failureToError,
  toError,
} from "./errors.js";
import {
  bullStates,
  decodeCursor,
  encodeCursor,
  everyState,
  isFinished,
  mergePage,
  queueEventMap,
  toJobsOptions,
  toSnapshot,
  toStatus,
} from "./mapping.js";
import type { SubmitDefaults } from "./mapping.js";
import type {
  AnyJobSnapshot,
  BulkOptions,
  CleanupQuery,
  Enqiu,
  EnqiuOptions,
  JobCallable,
  JobDefinitions,
  JobHandle,
  JobListQuery,
  JobSnapshot,
  JobsApi,
  QueueApi,
  QueueEventMap,
  QueueStats,
  ScheduleHandle,
  ScheduleOptions,
  ScheduleSnapshot,
  StandardSchemaV1,
  SubmitOptions,
  WorkerApi,
  WorkerStartOptions,
} from "./types.js";

export { job } from "./definition.js";

/**
 * What a handle needs to answer questions about its job.
 *
 * Three methods, and everything awkward about them is inside: that a cancelled
 * job may no longer exist, that BullMQ hands a failure back as a bare string,
 * and that only the worker holding a running job can abort it.
 */
class JobStore {
  constructor(
    private readonly queue: Queue,
    private readonly events: QueueEventStream,
    private readonly markers: CancellationMarkers,
    private readonly worker: Worker | undefined
  ) {}

  /**
   * `state` says what an event already proved, so the state need not be re-read.
   *
   * The job and its state are fetched together: `getJobState` needs only the id,
   * so waiting for the job first was a round trip spent for nothing.
   */
  async snapshot(id: string, state?: JobState): Promise<JobSnapshot | undefined> {
    const [bull, settled] = await Promise.all([
      this.queue.getJob(id),
      state ?? this.queue.getJobState(id),
    ]);
    // Gone means the marker is all there is — and the marker is a snapshot.
    if (!bull) return this.markers.read(id);
    // An aborted job settles as failed; the marker is what distinguishes a
    // deliberate cancellation from one that simply threw.
    if (settled === "failed") {
      const cancelled = await this.markers.read(id);
      if (cancelled) return cancelled;
    }
    return toSnapshot(bull, toStatus(settled));
  }

  async result(bull: BullJob): Promise<unknown> {
    const id = String(bull.id);
    try {
      return await bull.waitUntilFinished(await this.events.open());
    } catch (cause) {
      const error = toError(cause);
      // The free check first: a stored envelope needs no round trip to read.
      const failure = decodeFailure(error.message);
      if (failure) throw failureToError(failure);
      const cancelled = await this.markers.read(id);
      if (cancelled) throw new JobCancelledError(id, cancelled.error?.message);
      throw new JobFailedError(id, error.message, { cause: error });
    }
  }

  async cancel(bull: BullJob, reason: string): Promise<boolean> {
    const id = String(bull.id);
    const state = await bull.getState();
    if (state === "unknown" || isFinished(state)) return false;

    // Taken before anything is destroyed: once the job is removed this is the
    // only record that it ever existed, let alone what it carried. Finished
    // here, so a reader has nothing left to reassemble.
    const snapshot = toSnapshot(bull, "cancelled");
    snapshot.finishedAt = Date.now();
    snapshot.error = { name: "JobCancelledError", message: reason };

    if (state === "active") {
      // A running job cannot be removed, but this process's worker can abort
      // it if it is the one holding it. Another worker's job is not ours to
      // cancel, and BullMQ offers no cross-process signal for that.
      if (!this.worker?.cancelJob(id, reason)) return false;
    } else {
      try {
        await bull.remove();
      } catch {
        return false;
      }
    }

    await this.markers.write(id, snapshot);
    return true;
  }
}

class Handle<Output, Input, Name extends string>
  implements JobHandle<Output, Input, Name>
{
  private resultPromise: Promise<Output> | undefined;

  constructor(
    private readonly bull: BullJob,
    private readonly store: JobStore,
    readonly deduplicated: boolean
  ) {}

  get id(): string {
    return String(this.bull.id);
  }

  get name(): Name {
    return this.bull.name as Name;
  }

  get input(): Input {
    return this.bull.data as Input;
  }

  get result(): Promise<Output> {
    this.resultPromise ??= this.store.result(this.bull) as Promise<Output>;
    return this.resultPromise;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.store.cancel(this.bull, reason ?? "Job was cancelled");
  }

  async refresh(): Promise<JobSnapshot<Input, Output, Name>> {
    const snapshot = await this.store.snapshot(this.id);
    if (!snapshot) throw new Error(`Job "${this.id}" no longer exists`);
    return snapshot as JobSnapshot<Input, Output, Name>;
  }
}

/** The shared parts, named once so each API object can take only these. */
interface Runtime {
  readonly queue: Queue;
  readonly events: QueueEventStream;
  readonly markers: CancellationMarkers;
  readonly store: JobStore;
  readonly defaults: SubmitDefaults;
  assertOpen(): void;
  ready(): Promise<void>;
}

type AnyCallable = JobCallable<
  unknown,
  unknown,
  unknown,
  string,
  StandardSchemaV1 | undefined
>;

function createJobCallable(
  name: string,
  definition: RuntimeDefinition,
  runtime: Runtime
): AnyCallable {
  const options = (submit: SubmitOptions) =>
    toJobsOptions(submit, definition.policy, runtime.defaults);

  const submit = async (
    input: unknown,
    submitOptions: SubmitOptions = {}
  ): Promise<JobHandle> => {
    await runtime.ready();
    const value = assertJobValue(
      await validateInput(name, definition.schema, input)
    );
    // Ask before adding: on a hit BullMQ returns the *existing* job, so
    // afterwards its id is the deduplication owner and the two are
    // indistinguishable.
    let deduplicated = false;
    if (submitOptions.idempotencyKey !== undefined) {
      const owner = await runtime.queue.getDeduplicationJobId(
        submitOptions.idempotencyKey
      );
      deduplicated = owner !== undefined && owner !== null;
    }
    const bull = await runtime.queue.add(name, value, options(submitOptions));
    return new Handle(bull, runtime.store, deduplicated);
  };

  const bulk = async (
    inputs: readonly unknown[],
    bulkOptions: BulkOptions = {}
  ): Promise<JobHandle[]> => {
    if (bulkOptions.ids && bulkOptions.ids.length !== inputs.length) {
      throw new RangeError("bulk ids must match the number of inputs");
    }
    await runtime.ready();
    const values = await Promise.all(
      inputs.map(async (input) =>
        assertJobValue(await validateInput(name, definition.schema, input))
      )
    );
    // Only the id varies across the batch, so the rest is resolved once.
    const shared = options(bulkOptions);
    const created = await runtime.queue.addBulk(
      values.map((data, index) => {
        const id = bulkOptions.ids?.[index];
        return {
          name,
          data,
          opts: id === undefined ? shared : { ...shared, jobId: id },
        };
      })
    );
    return created.map((bull) => new Handle(bull, runtime.store, false));
  };

  const schedule = async (
    scheduleOptions: ScheduleOptions<unknown>
  ): Promise<ScheduleHandle> => {
    runtime.assertOpen();
    const value = assertJobValue(
      await validateInput(name, definition.schema, scheduleOptions.input)
    );
    const id = scheduleOptions.id?.trim() || name;
    await runtime.queue.upsertJobScheduler(
      id,
      {
        pattern: scheduleOptions.cron,
        ...(scheduleOptions.timezone === undefined
          ? {}
          : { tz: scheduleOptions.timezone }),
      },
      { name, data: value }
    );
    return scheduleHandle(id, name, runtime.queue);
  };

  return Object.assign(submit, { bulk, schedule, input: definition.schema });
}

function scheduleHandle(
  id: string,
  jobName: string,
  queue: Queue
): ScheduleHandle {
  return {
    id,
    remove: async () => {
      await queue.removeJobScheduler(id);
    },
    refresh: async (): Promise<ScheduleSnapshot> => {
      const scheduler = await queue.getJobScheduler(id);
      if (!scheduler) throw new Error(`Schedule "${id}" does not exist`);
      return {
        id,
        jobName,
        cron: String(scheduler.pattern ?? ""),
        timezone: String(scheduler.tz ?? "UTC"),
        nextRunAt: Number(scheduler.next ?? 0),
        input: scheduler.template?.data,
      };
    },
  };
}

function createQueueApi<Definitions extends JobDefinitions>(
  runtime: Runtime
): QueueApi<Definitions> {
  const { queue, markers, store, events } = runtime;

  return Object.freeze({
    get: async (id: string) =>
      (await store.snapshot(id)) as AnyJobSnapshot<Definitions> | undefined,

    list: async (query: JobListQuery) => {
      const limit = query.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw new RangeError("list.limit must be an integer between 1 and 1000");
      }
      const states = bullStates[query.status];
      if (states.length === 0) return { jobs: [] };

      // One range per state, each with its own offset, because BullMQ applies
      // a range to every state separately.
      const offsets = decodeCursor(query.cursor, states.length);
      const pages = await Promise.all(
        states.map(async (state, index) => {
          const offset = offsets[index] ?? 0;
          return {
            offset,
            items: await queue.getJobs([state], offset, offset + limit - 1),
          };
        })
      );

      const { items, next } = mergePage(pages, limit);
      const jobs = items.map((bull) =>
        toSnapshot(bull, query.status)
      ) as AnyJobSnapshot<Definitions>[];
      return items.length === limit
        ? { jobs, cursor: encodeCursor(next) }
        : { jobs };
    },

    stats: async (): Promise<QueueStats> => {
      const counts = await queue.getJobCounts(...everyState);
      const sum = (status: keyof typeof bullStates): number =>
        bullStates[status].reduce((n, state) => n + (counts[state] ?? 0), 0);
      const stats = {
        queued: sum("queued"),
        scheduled: sum("scheduled"),
        running: sum("running"),
        succeeded: sum("succeeded"),
        failed: sum("failed"),
      };
      return {
        ...stats,
        total: Object.values(stats).reduce((a, b) => a + b, 0),
      };
    },

    redrive: async (id: string) => {
      const bull = await queue.getJob(id);
      if (!bull) throw new Error(`Job "${id}" cannot be redriven`);
      const state = await bull.getState();
      if (!isFinished(state)) throw new Error(`Job "${id}" cannot be redriven`);
      await bull.retry(state);
      return new Handle(bull, store, false);
    },

    cleanup: async (query: CleanupQuery = {}) => {
      const olderThan = query.olderThan ?? 0;
      if (!Number.isFinite(olderThan) || olderThan < 0) {
        throw new RangeError("olderThan must be a non-negative finite number");
      }
      // Every state the status is made of: cleaning only the first left
      // prioritized jobs behind and reported success.
      const limit = query.limit ?? 1000;
      const removed = await Promise.all(
        bullStates[query.status ?? "succeeded"].map((state) =>
          queue.clean(olderThan, limit, state)
        )
      );
      await markers.prune(Date.now() - olderThan);
      return removed.flat();
    },

    onIdle: async () => {
      // BullMQ has no idle signal, so poll the counts it already maintains
      // rather than tracking the same state in parallel. The wait widens so
      // that draining a long queue does not sit at 50 polls a second.
      for (let wait = 20; ; wait = Math.min(wait * 2, 250)) {
        const outstanding = await queue.getJobCountByTypes(
          "waiting",
          "active",
          "delayed",
          "prioritized"
        );
        if (outstanding === 0) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },

    on: <Event extends keyof QueueEventMap>(
      event: Event,
      listener: (payload: QueueEventMap[Event]) => void
    ) => {
      const { name, state } = queueEventMap[event];
      const deliver = listener as (payload: unknown) => void;
      // `error` carries an Error rather than a job, and which one this is was
      // settled when on() was called — not on every delivery.
      const handler =
        event === "error"
          ? deliver
          : ({ jobId }: { jobId: string }): void => {
              // The event already says what state the job is in, so only the
              // job itself has to be fetched.
              void store.snapshot(jobId, state).then((snapshot) => {
                if (snapshot) deliver(snapshot);
              });
            };
      // Attaching has to wait for the stream to open, so unsubscribing before
      // that has to be remembered rather than applied.
      let detach: (() => void) | undefined;
      let unsubscribed = false;
      void events.open().then((stream) => {
        if (unsubscribed) return;
        stream.on(name, handler as never);
        detach = () => stream.off(name, handler as never);
      });
      return () => {
        unsubscribed = true;
        detach?.();
      };
    },
  } satisfies QueueApi<Definitions>);
}

function createWorkerApi(worker: Worker | undefined): WorkerApi {
  return Object.freeze({
    /**
     * Read from BullMQ rather than mirrored here. A caller holding
     * `bull.worker` can pause it, and a flag maintained alongside would go on
     * claiming otherwise.
     */
    get running() {
      return worker !== undefined && worker.isRunning() && !worker.isPaused();
    },
    start: async (options: WorkerStartOptions = {}) => {
      if (!worker) {
        throw new TypeError(
          "This queue was created with worker: false and cannot run jobs"
        );
      }
      if (options.concurrency !== undefined) {
        worker.concurrency = options.concurrency;
      }
      // Awaited on purpose. BullMQ's resume() restarts the main loop only if it
      // has *already* exited, and right after a pause the loop is still
      // unwinding — so checking isRunning() before that settles saw a live loop
      // about to die, and left the worker resumed but not running.
      if (worker.isPaused()) await worker.resume();
      if (!worker.isRunning()) void worker.run();
    },
  } satisfies WorkerApi);
}

/** Build a typed job API backed by a BullMQ queue. */
export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options: EnqiuOptions
): Enqiu<Definitions> {
  const runtimeDefinitions = new Map<string, RuntimeDefinition>();
  for (const [name, definition] of Object.entries(definitions)) {
    runtimeDefinitions.set(name, normalizeDefinition(definition));
  }
  if (runtimeDefinitions.size === 0) {
    throw new TypeError("At least one job definition is required");
  }
  if (!options.connection) {
    throw new TypeError("enqiu() requires a BullMQ connection");
  }

  const queueName = options.name ?? "default";
  const base = {
    connection: options.connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
  };
  const queue = new Queue(queueName, base);

  let worker: Worker | undefined;
  if (options.worker !== false) {
    const { concurrency, autoStart = true } = options.worker ?? {};
    const runner = new JobRunner(runtimeDefinitions, { timeout: options.timeout });
    worker = new Worker(
      queueName,
      // Three parameters on purpose: BullMQ decides whether to create an
      // AbortController by reading `processor.length >= 3`. Declaring fewer
      // means worker.cancelJob() can never abort anything.
      async (bull: BullJob, _token?: string, signal?: AbortSignal) =>
        runner.run(bull, signal),
      {
        ...base,
        ...(concurrency === undefined ? {} : { concurrency }),
        autorun: false,
      }
    );
    if (autoStart) void worker.run();
  }

  const events = new QueueEventStream(queue, base);
  const markers = new CancellationMarkers(queue);
  const store = new JobStore(queue, events, markers, worker);

  const runtime: Runtime = {
    queue,
    events,
    markers,
    store,
    defaults: {
      logLimit: options.logLimit ?? 100,
      retry: options.retry,
    },
    // Read from BullMQ, so closing `bull.queue` underneath is seen here too.
    assertOpen: () => {
      if (queue.closing !== undefined) throw new QueueClosedError(queueName);
    },
    ready: async () => {
      runtime.assertOpen();
      await events.settle();
    },
  };

  const jobs: Record<string, AnyCallable> = {};
  for (const [name, definition] of runtimeDefinitions) {
    jobs[name] = createJobCallable(name, definition, runtime);
  }

  const queueApi = createQueueApi<Definitions>(runtime);
  const workerApi = createWorkerApi(worker);

  return Object.freeze({
    jobs: Object.freeze(jobs) as JobsApi<Definitions>,
    queue: queueApi,
    worker: workerApi,
    bull: Object.freeze({ queue, worker }),
    close: async (closeOptions?: { drain?: boolean }) => {
      if ((closeOptions?.drain ?? true) && workerApi.running) {
        await queueApi.onIdle();
      }
      // Three independent connections: closing the worker waits out the jobs
      // it holds, which the other two have no reason to wait for.
      await Promise.all([worker?.close(), events.close(), queue.close()]);
    },
  });
}
