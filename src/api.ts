/**
 * Public entry point: `enqiu()` and the facade it returns.
 *
 * Types and the `job()` helper live in ./api/types.js, option normalisation in
 * ./api/options.js, and handler-context construction in ./api/context.js.
 */

import { JobSerializationError, cloneJobValue } from "./codec.js";
import {
  DuplicateJobIdError,
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
} from "./memory.js";
import { compact } from "./internal/object.js";
import { createMemoryDriver } from "./drivers/memory.js";
import { createContext } from "./api/context.js";
import {
  normalizeDefinition,
  normalizeRetryPolicy,
  toAddOptions,
  validateInput,
} from "./api/options.js";
/** Names the api object itself uses, so a job may not take them. */
export const reservedNames = new Set(["queue", "worker"]);
import type { JobContext as HandlerContext, JobSnapshot, JobStatus } from "./memory.js";
import type {
  DriverHandlers,
  DriverJob,
  DriverQueueOptions,
  QueueDriver,
  ScheduleHandle,
} from "./driver.js";
import type {
  AnyJobSnapshot,
  BulkOptions,
  CleanupQuery,
  DriverEnqiuOptions,
  EnqiuOptions,
  JobCallable,
  JobDefinitions,
  JobHandle,
  JobListPage,
  JobListQuery,
  JobsApi,
  MemoryEnqiuOptions,
  NormalizedDefinition,
  QueueApi,
  ScheduleOptions,
  StandardSchemaV1,
  SubmitOptions,
  WorkerApi,
  WorkerStartOptions,
} from "./api/types.js";
import type { QueueEventMap } from "./memory.js";

export * from "./api/types.js";
export { JobValidationError, job } from "./api/job.js";

class PublicJobHandle<
  Output,
  Input,
  Name extends string,
> implements JobHandle<Output, Input, Name> {
  private resultPromise: Promise<Output> | undefined;

  constructor(private readonly job: DriverJob) {}

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

  get deduplicated(): boolean {
    return this.job.deduplicated;
  }

  get result(): Promise<Output> {
    this.resultPromise ??= this.job.result as Promise<Output>;
    return this.resultPromise;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.job.cancel(reason);
  }

  refresh(): Promise<JobSnapshot<Input, Output, Name>> {
    return this.job.snapshot() as Promise<JobSnapshot<Input, Output, Name>>;
  }
}

class EnqiuFacade<Definitions extends JobDefinitions> {
  readonly api: JobsApi<Definitions>;

  private readonly definitions = new Map<string, NormalizedDefinition>();
  private readonly driver: QueueDriver;
  private workerRunning: boolean;

  constructor(
    definitions: Definitions,
    private readonly options: EnqiuOptions
  ) {
    const handlers: DriverHandlers = {};
    for (const [name, definition] of Object.entries(definitions)) {
      if (reservedNames.has(name)) {
        throw new TypeError(`"${name}" is reserved by enqiu`);
      }
      const normalized = normalizeDefinition(definition);
      this.definitions.set(name, normalized);
      handlers[name] = async (
        input: unknown,
        context: HandlerContext
      ): Promise<unknown> => {
        const output = await normalized.run(
          input,
          createContext(context, options.name ?? "default", options.telemetry)
        );
        return cloneJobValue(output);
      };
    }
    if (this.definitions.size === 0) {
      throw new TypeError("At least one job definition is required");
    }

    const workerOptions = options.worker === false ? undefined : options.worker;
    const worker = options.worker !== false;
    const concurrency = worker ? workerOptions?.concurrency : 1;
    const autoStart = worker ? workerOptions?.autoStart ?? true : false;

    const queueOptions: DriverQueueOptions = compact({
      name: options.name,
      worker,
      concurrency,
      autoStart,
      retry: normalizeRetryPolicy(options.retry),
      timeout: options.timeout,
      historyLimit: options.historyLimit,
      logLimit: options.logLimit,
    });

    this.driver = options.driver
      ? options.driver.createQueue(handlers, queueOptions)
      : createMemoryDriver(handlers, queueOptions);
    this.workerRunning = autoStart && worker;

    const target: Record<PropertyKey, unknown> = {};
    for (const name of this.definitions.keys()) {
      target[name] = this.createCallable(name);
    }
    target.queue = this.createQueueApi();
    target.worker = this.createWorkerApi();
    this.api = Object.freeze(target) as JobsApi<Definitions>;
    this.connectTelemetry();
  }

  private createCallable(name: string): JobCallable<
    unknown,
    unknown,
    unknown,
    string,
    StandardSchemaV1 | undefined
  > {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new TypeError(`Unknown job "${name}"`);
    }

    const callable = async (
      input: unknown,
      options: SubmitOptions = {}
    ): Promise<JobHandle> => {
      const value = cloneJobValue(
        await validateInput(name, definition.schema, input)
      );
      const job = this.driver.add(
        name,
        value,
        toAddOptions(options, definition.policy, name, value)
      );
      await job.accepted;
      return new PublicJobHandle(job);
    };

    const bulk = async (
      inputs: readonly unknown[],
      options: BulkOptions = {}
    ): Promise<JobHandle[]> => {
      if (options.ids && options.ids.length !== inputs.length) {
        throw new RangeError("bulk ids must match the number of inputs");
      }
      const values = await Promise.all(
        inputs.map(async (input) =>
          cloneJobValue(await validateInput(name, definition.schema, input))
        )
      );
      const jobs = values.map((value, index) => {
        const submitOptions = compact({
          ...options,
          ids: undefined,
          id: options.ids?.[index],
        }) as SubmitOptions;
        return this.driver.add(
          name,
          value,
          toAddOptions(submitOptions, definition.policy, name, value)
        );
      });
      await Promise.all(jobs.map((job) => job.accepted));
      return jobs.map((job) => new PublicJobHandle(job));
    };

    const schedule = async (
      options: ScheduleOptions<unknown>
    ): Promise<ScheduleHandle> => {
      const value = cloneJobValue(
        await validateInput(name, definition.schema, options.input)
      );
      return this.driver.upsertSchedule({
        id: options.id,
        jobName: name,
        cron: options.cron,
        timezone: options.timezone,
        input: value,
        catchUp: options.catchUp,
        submit: toAddOptions({}, definition.policy, name, value),
      });
    };

    Object.defineProperties(callable, {
      bulk: { value: bulk, enumerable: true },
      schedule: { value: schedule, enumerable: true },
      input: { value: definition.schema, enumerable: true },
    });

    return callable as JobCallable<
      unknown,
      unknown,
      unknown,
      string,
      StandardSchemaV1 | undefined
    >;
  }

  private createQueueApi(): QueueApi<Definitions> {
    return Object.freeze({
      get: async (id: string) =>
        (await this.driver.get(id)) as
          | AnyJobSnapshot<Definitions>
          | undefined,
      list: async (query: JobListQuery = {}) =>
        (await this.driver.list(query)) as JobListPage<
          AnyJobSnapshot<Definitions>
        >,
      stats: () => this.driver.stats(),
      pause: () => this.driver.pauseQueue(),
      resume: () => this.driver.resumeQueue(),
      setConcurrency: (limit: number) =>
        this.driver.setQueueConcurrency(limit),
      redrive: async (id: string) =>
        new PublicJobHandle(await this.driver.redrive(id)),
      cleanup: (query: CleanupQuery = {}) => this.driver.cleanup(query),
      on: <Event extends keyof QueueEventMap>(
        event: Event,
        listener: (payload: QueueEventMap[Event]) => void
      ) => this.driver.on(event, listener),
    } satisfies QueueApi<Definitions>);
  }

  private createWorkerApi(): WorkerApi {
    const facade = this;
    return Object.freeze({
      get running() {
        return facade.workerRunning;
      },
      start: async (options: WorkerStartOptions = {}) => {
        await facade.driver.startWorker(options.concurrency);
        facade.workerRunning = true;
      },
      pause: async () => {
        await facade.driver.pauseWorker();
        facade.workerRunning = false;
      },
      resume: async () => {
        await facade.driver.startWorker();
        facade.workerRunning = true;
      },
      onIdle: () => facade.driver.onIdle(),
      close: async (options?: { drain?: boolean }) => {
        await facade.driver.close(options);
        facade.workerRunning = false;
      },
    } satisfies WorkerApi);
  }

  private connectTelemetry(): void {
    const telemetry = this.options.telemetry;
    if (!telemetry) {
      return;
    }
    const events: Array<keyof QueueEventMap> = [
      "added",
      "started",
      "retry",
      "succeeded",
      "failed",
      "cancelled",
      "expired",
    ];
    for (const event of events) {
      this.driver.on(event, (payload: QueueEventMap[keyof QueueEventMap]) => {
        const snapshot =
          "job" in Object(payload)
            ? (payload as QueueEventMap["retry"]).job
            : (payload as JobSnapshot);
        telemetry.emit({
          type: `job.${event}`,
          queue: this.options.name ?? "default",
          timestamp: Date.now(),
          job: snapshot,
        });
      });
    }
  }

}

export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options?: MemoryEnqiuOptions
): JobsApi<Definitions>;
export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options: DriverEnqiuOptions
): JobsApi<Definitions>;
export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options: EnqiuOptions = {}
): JobsApi<Definitions> {
  return new EnqiuFacade(definitions, options).api;
}


export {
  DuplicateJobIdError,
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobSerializationError,
  JobTimeoutError,
  QueueClosedError,
};
