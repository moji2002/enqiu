import {
  MemoryQueue,
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
} from "./memory.js";
import type {
  AddOptions as LegacyAddOptions,
  Job as LegacyMemoryJob,
  JobContext as LegacyJobContext,
  JobHandler as LegacyJobHandler,
  JobMap as LegacyJobMap,
  JobSnapshot,
  JobStatus,
  MaybePromise,
  QueueEventMap,
  QueueStats,
  RetryOptions,
} from "./memory.js";
import {
  RedisQueue,
  type RedisDriver,
  type RedisAddOptions,
  type RedisJob as LegacyRedisJob,
  type RedisQueueEventMap,
  type RedisQueueOptions as LegacyRedisQueueOptions,
} from "./redis.js";
import {
  JobSerializationError,
  cloneJobValue,
} from "./codec.js";
import { MemoryScheduler } from "./memory-scheduler.js";

const definitionMarker = Symbol("enqiu.job");
const reservedNames = new Set(["queue", "worker"]);

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => MaybePromise<
      | { readonly value: Output; readonly issues?: undefined }
      | {
          readonly value?: undefined;
          readonly issues: readonly StandardSchemaIssue[];
        }
    >;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type InferSchemaInput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["input"];

export type InferSchemaOutput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["output"];

export interface Progress {
  readonly completed: number;
  readonly total: number;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface JobLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface JobContext<Name extends string = string> {
  readonly id: string;
  readonly name: Name;
  readonly attempt: number;
  readonly signal: AbortSignal;
  reportProgress(progress: Progress): Promise<void>;
  readonly log: JobLogger;
}

export type JobHandler<
  Input = unknown,
  Output = unknown,
  Name extends string = string,
> = (
  input: Input,
  context: JobContext<Name>
) => MaybePromise<Output>;

export interface RetryPolicy
  extends Omit<RetryOptions, "retries"> {
  /** Total number of attempts, including the first. */
  attempts: number;
}

export interface ConcurrencyPolicy<Input> {
  limit: number;
  by?: (input: Input) => string;
}

export interface ThrottlePolicy<Input> {
  limit: number;
  per: number;
  burst?: number;
  by?: (input: Input) => string;
}

export interface DebouncePolicy<Input> {
  wait: number;
  mode: "leading" | "trailing";
  by: (input: Input) => string;
}

export interface JobPolicyOptions<Input> {
  retry?: number | RetryPolicy;
  timeout?: number;
  expiresIn?: number;
  concurrency?: number | ConcurrencyPolicy<Input>;
  throttle?: ThrottlePolicy<Input>;
  debounce?: DebouncePolicy<Input>;
}

export interface SchemaJobDefinition<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
  Output = unknown,
> extends JobPolicyOptions<InferSchemaOutput<Schema>> {
  readonly [definitionMarker]: true;
  readonly input: Schema;
  readonly run: JobHandler<InferSchemaOutput<Schema>, Output>;
}

export type HandlerJobDefinition<
  Input = unknown,
  Output = unknown,
> = JobHandler<Input, Output>;

export type JobDefinition =
  | SchemaJobDefinition<StandardSchemaV1<unknown, unknown>, unknown>
  | HandlerJobDefinition<unknown, unknown>;

export type JobDefinitions = Record<string, JobDefinition>;

export function job<
  const Schema extends StandardSchemaV1,
  Output,
>(
  definition: Omit<SchemaJobDefinition<Schema, Output>, typeof definitionMarker>
): SchemaJobDefinition<Schema, Output> {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("job() requires a definition object");
  }
  if (!isStandardSchema(definition.input)) {
    throw new TypeError("job.input must implement Standard Schema");
  }
  if (typeof definition.run !== "function") {
    throw new TypeError("job.run must be a function");
  }
  return Object.freeze({
    ...definition,
    [definitionMarker]: true as const,
  });
}

type DefinitionInput<Definition> =
  Definition extends SchemaJobDefinition<infer Schema, unknown>
    ? InferSchemaInput<Schema>
    : Definition extends JobHandler<infer Input, unknown, string>
      ? Input
      : never;

type DefinitionRunInput<Definition> =
  Definition extends SchemaJobDefinition<infer Schema, unknown>
    ? InferSchemaOutput<Schema>
    : Definition extends JobHandler<infer Input, unknown, string>
      ? Input
      : never;

type DefinitionOutput<Definition> =
  Definition extends SchemaJobDefinition<StandardSchemaV1, infer Output>
    ? Awaited<Output>
    : Definition extends JobHandler<unknown, infer Output, string>
      ? Awaited<Output>
      : never;

export interface SubmitOptions {
  id?: string;
  idempotencyKey?: string;
  /** Keep returning the same completed job for this duration. @default 24h */
  idempotencyTtl?: number;
  delay?: number | Date;
  priority?: number | "low" | "normal" | "high";
  retry?: number | RetryPolicy;
  timeout?: number;
  expiresIn?: number;
  signal?: AbortSignal;
}

export interface BulkOptions extends Omit<SubmitOptions, "id"> {
  ids?: readonly string[];
}

export interface ScheduleOptions<Input> {
  id?: string;
  cron: string;
  timezone?: string;
  input: Input;
  catchUp?: boolean;
}

export interface ScheduleHandle {
  readonly id: string;
  readonly nextRunAt: number;
  pause(): Promise<void>;
  resume(): Promise<void>;
  remove(): Promise<void>;
  refresh(): Promise<ScheduleSnapshot>;
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

export interface JobHandle<
  Output = unknown,
  Input = unknown,
  Name extends string = string,
> {
  readonly id: string;
  readonly name: Name;
  readonly input: Input;
  readonly status: JobStatus;
  readonly deduplicated: boolean;
  readonly result: Promise<Output>;
  cancel(reason?: string): Promise<boolean>;
  refresh(): Promise<JobSnapshot<Input, Output, Name>>;
}

export interface JobCallable<
  Input,
  RunInput,
  Output,
  Name extends string,
  Schema extends StandardSchemaV1 | undefined = undefined,
> {
  (input: Input, options?: SubmitOptions): Promise<
    JobHandle<Output, RunInput, Name>
  >;
  bulk(
    inputs: readonly Input[],
    options?: BulkOptions
  ): Promise<Array<JobHandle<Output, RunInput, Name>>>;
  schedule(options: ScheduleOptions<Input>): Promise<ScheduleHandle>;
  readonly input: Schema;
}

type DefinitionSchema<Definition> =
  Definition extends SchemaJobDefinition<infer Schema, unknown>
    ? Schema
    : undefined;

export type JobsApi<Definitions extends JobDefinitions> = {
  readonly [Name in keyof Definitions]: JobCallable<
    DefinitionInput<Definitions[Name]>,
    DefinitionRunInput<Definitions[Name]>,
    DefinitionOutput<Definitions[Name]>,
    Extract<Name, string>,
    DefinitionSchema<Definitions[Name]>
  >;
} & {
  readonly queue: QueueApi<Definitions>;
  readonly worker: WorkerApi;
};

export type AnyJobSnapshot<Definitions extends JobDefinitions> = {
  [Name in keyof Definitions]: JobSnapshot<
    DefinitionRunInput<Definitions[Name]>,
    DefinitionOutput<Definitions[Name]>,
    Extract<Name, string>
  >;
}[keyof Definitions];

export interface JobListQuery {
  status?: JobStatus;
  name?: string;
  before?: number;
  after?: number;
  limit?: number;
  cursor?: string;
}

export interface JobListPage<Job = JobSnapshot> {
  jobs: Job[];
  cursor?: string;
}

export interface CleanupQuery {
  status?: JobStatus | readonly JobStatus[];
  olderThan?: number;
  limit?: number;
}

export interface QueueApi<Definitions extends JobDefinitions> {
  get(id: string): Promise<AnyJobSnapshot<Definitions> | undefined>;
  list(
    query?: JobListQuery
  ): Promise<JobListPage<AnyJobSnapshot<Definitions>>>;
  stats(): Promise<QueueStats>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setConcurrency(limit: number): Promise<void>;
  redrive(id: string): Promise<JobHandle>;
  cleanup(query?: CleanupQuery): Promise<string[]>;
  on<Event extends keyof QueueEventMap>(
    event: Event,
    listener: (payload: QueueEventMap[Event]) => void
  ): () => void;
}

export interface WorkerStartOptions {
  concurrency?: number;
}

export interface WorkerApi {
  readonly running: boolean;
  start(options?: WorkerStartOptions): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  onIdle(): Promise<void>;
  close(options?: { drain?: boolean }): Promise<void>;
}

export interface WorkerOptions {
  concurrency?: number;
  autoStart?: boolean;
}

export interface TelemetryEvent {
  readonly type: string;
  readonly queue: string;
  readonly timestamp: number;
  readonly job?: JobSnapshot;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface Telemetry {
  emit(event: TelemetryEvent): void;
}

export interface SharedEnqiuOptions {
  name?: string;
  worker?: false | WorkerOptions;
  retry?: number | RetryPolicy;
  timeout?: number;
  historyLimit?: number;
  logLimit?: number;
  telemetry?: Telemetry;
}

export interface MemoryEnqiuOptions extends SharedEnqiuOptions {
  driver?: undefined;
}

export interface RedisEnqiuOptions extends SharedEnqiuOptions {
  driver: RedisDriver;
  /** Redis processes must explicitly choose producer-only or worker mode. */
  worker: false | WorkerOptions;
}

export type EnqiuOptions = MemoryEnqiuOptions | RedisEnqiuOptions;

interface NormalizedDefinition {
  schema: StandardSchemaV1 | undefined;
  run: JobHandler;
  policy: JobPolicyOptions<unknown>;
}

type RuntimeJobMap = Record<string, LegacyJobHandler<unknown, unknown>>;
type LegacyJob = LegacyMemoryJob | LegacyRedisJob;

export class JobValidationError extends TypeError {
  readonly issues: readonly StandardSchemaIssue[];

  constructor(name: string, issues: readonly StandardSchemaIssue[]) {
    super(
      `Invalid input for job "${name}": ${
        issues[0]?.message ?? "validation failed"
      }`
    );
    this.name = "JobValidationError";
    this.issues = issues;
  }
}

class PublicJobHandle<
  Output,
  Input,
  Name extends string,
> implements JobHandle<Output, Input, Name> {
  private resultPromise: Promise<Output> | undefined;

  constructor(private readonly legacy: LegacyJob) {}

  get id(): string {
    return this.legacy.id;
  }

  get name(): Name {
    return this.legacy.name as Name;
  }

  get input(): Input {
    return this.legacy.input as Input;
  }

  get status(): JobStatus {
    return this.legacy.status;
  }

  get deduplicated(): boolean {
    return this.legacy.deduplicated;
  }

  get result(): Promise<Output> {
    this.resultPromise ??= this.legacy.result as Promise<Output>;
    return this.resultPromise;
  }

  async cancel(reason?: string): Promise<boolean> {
    return this.legacy.cancel(reason);
  }

  async refresh(): Promise<JobSnapshot<Input, Output, Name>> {
    if ("refresh" in this.legacy) {
      return this.legacy.refresh() as Promise<
        JobSnapshot<Input, Output, Name>
      >;
    }
    return this.legacy.snapshot() as JobSnapshot<Input, Output, Name>;
  }
}

class EnqiuFacade<Definitions extends JobDefinitions> {
  readonly api: JobsApi<Definitions>;

  private readonly definitions = new Map<string, NormalizedDefinition>();
  private readonly memory: MemoryQueue<RuntimeJobMap> | undefined;
  private readonly redis: RedisQueue<RuntimeJobMap> | undefined;
  private readonly memoryScheduler: MemoryScheduler | undefined;
  private workerRunning: boolean;

  constructor(
    definitions: Definitions,
    private readonly options: EnqiuOptions
  ) {
    const handlers: RuntimeJobMap = {};
    for (const [name, definition] of Object.entries(definitions)) {
      if (reservedNames.has(name)) {
        throw new TypeError(`"${name}" is reserved by enqiu`);
      }
      const normalized = normalizeDefinition(definition);
      this.definitions.set(name, normalized);
      handlers[name] = async (
        input: unknown,
        context: LegacyJobContext
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

    const concurrency =
      options.worker === false ? 1 : options.worker?.concurrency;
    const autoStart =
      options.worker === false
        ? false
        : options.worker?.autoStart ?? true;
    const retry = normalizeLegacyRetry(options.retry);

    if (options.driver) {
      this.redis = new RedisQueue(handlers, compact({
        driver: options.driver,
        name: options.name,
        worker: options.worker !== false,
        concurrency,
        autoStart,
        retry: retry as LegacyRedisQueueOptions["retry"],
        timeout: options.timeout,
        historyLimit: options.historyLimit,
        logLimit: options.logLimit,
      }));
      this.workerRunning = autoStart && options.worker !== false;
    } else {
      this.memory = new MemoryQueue(handlers, compact({
        name: options.name,
        concurrency,
        autoStart,
        retry,
        timeout: options.timeout,
        historyLimit: options.historyLimit,
        logLimit: options.logLimit,
      }));
      this.memoryScheduler = new MemoryScheduler();
      this.workerRunning = autoStart;
    }

    const target: Record<PropertyKey, unknown> = {};
    for (const name of this.definitions.keys()) {
      target[name] = this.createCallable(name);
    }
    target.queue = this.createQueueApi();
    target.worker = this.createWorkerApi();
    this.api = Object.freeze(target) as JobsApi<Definitions>;
    this.connectTelemetry();
  }

  private get queue(): MemoryQueue<RuntimeJobMap> | RedisQueue<RuntimeJobMap> {
    return this.redis ?? (this.memory as MemoryQueue<RuntimeJobMap>);
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
      const legacy = this.addLegacy(
        name,
        value,
        toLegacyOptions(options, definition.policy, name, value)
      );
      if ("accepted" in legacy) {
        await legacy.accepted;
      }
      return new PublicJobHandle(legacy);
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
      const handles = values.map((value, index) => {
        const id = options.ids?.[index];
        const submitOptions = compact({
          ...options,
          ids: undefined,
          id,
        }) as SubmitOptions;
        return this.addLegacy(
          name,
          value,
          toLegacyOptions(
            submitOptions,
            definition.policy,
            name,
            value
          )
        );
      });
      await Promise.all(
        handles.map((handle) =>
          "accepted" in handle ? handle.accepted : Promise.resolve()
        )
      );
      return handles.map((handle) => new PublicJobHandle(handle));
    };

    const schedule = async (
      options: ScheduleOptions<unknown>
    ): Promise<ScheduleHandle> => {
      const value = cloneJobValue(
        await validateInput(name, definition.schema, options.input)
      );
      if (this.redis) {
        return this.redis.upsertSchedule({
          ...options,
          input: value,
          jobName: name,
          submit: toLegacyOptions(
            {},
            definition.policy,
            name,
            value
          ) as RedisAddOptions,
        });
      }
      const scheduleId = options.id?.trim() || name;
      return (this.memoryScheduler as MemoryScheduler).upsert({
        ...options,
        input: value,
        jobName: name,
        enqueue: async (scheduledInput, occurrence) => {
          const handle = await callable(scheduledInput, {
            id: `${this.options.name ?? "default"}:schedule:${scheduleId}:${occurrence}`,
          });
          void handle;
        },
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
        (await this.queue.get(id)) as
          | AnyJobSnapshot<Definitions>
          | undefined,
      list: async (query: JobListQuery = {}) => {
        if (this.redis) {
          return this.redis.list(query) as Promise<
            JobListPage<AnyJobSnapshot<Definitions>>
          >;
        }
        let jobs = this.memory?.list(query.status) ?? [];
        if (query.name) {
          jobs = jobs.filter((item) => item.name === query.name);
        }
        if (query.after !== undefined) {
          jobs = jobs.filter((item) => item.createdAt > query.after!);
        }
        if (query.before !== undefined) {
          jobs = jobs.filter((item) => item.createdAt < query.before!);
        }
        const limit = query.limit ?? 100;
        return {
          jobs: jobs.slice(0, limit) as AnyJobSnapshot<Definitions>[],
        };
      },
      stats: async () =>
        this.redis ? this.redis.stats() : (this.memory as MemoryQueue<RuntimeJobMap>).stats,
      pause: async () => {
        if (this.redis) {
          await this.redis.pauseQueue();
        } else {
          this.memory?.pause();
        }
      },
      resume: async () => {
        if (this.redis) {
          await this.redis.resumeQueue();
        } else {
          this.memory?.start();
        }
      },
      setConcurrency: async (limit: number) => {
        if (this.redis) {
          await this.redis.setGlobalConcurrency(limit);
          return;
        }
        (this.memory as MemoryQueue<RuntimeJobMap>).concurrency = limit;
      },
      redrive: async (id: string) => {
        if (this.redis) {
          return new PublicJobHandle(
            (await this.redis.redrive(id)) as LegacyJob
          );
        }
        const handle = this.memory?.retry(id);
        if (!handle) {
          throw new Error(`Job "${id}" cannot be redriven`);
        }
        return new PublicJobHandle(handle);
      },
      cleanup: async (query: CleanupQuery = {}) => {
        if (this.redis) {
          return this.redis.cleanup(query);
        }
        return (
          this.memory?.cleanup(compact({
            olderThan: query.olderThan,
            limit: query.limit,
          })) ?? []
        );
      },
      on: <Event extends keyof QueueEventMap>(
        event: Event,
        listener: (payload: QueueEventMap[Event]) => void
      ) => {
        const events = this.queue as {
          on<EventName extends keyof RedisQueueEventMap>(
            event: EventName,
            listener: (payload: RedisQueueEventMap[EventName]) => void
          ): () => void;
        };
        return events.on(event, listener);
      },
    } satisfies QueueApi<Definitions>);
  }

  private createWorkerApi(): WorkerApi {
    const facade = this;
    return Object.freeze({
      get running() {
        return facade.workerRunning;
      },
      start: async (options: WorkerStartOptions = {}) => {
        if (options.concurrency !== undefined) {
          if (facade.redis) {
            facade.redis.setWorkerConcurrency(options.concurrency);
          } else {
            (facade.memory as MemoryQueue<RuntimeJobMap>).concurrency =
              options.concurrency;
          }
        }
        facade.queue.start();
        facade.workerRunning = true;
      },
      pause: async () => {
        facade.queue.pause();
        facade.workerRunning = false;
      },
      resume: async () => {
        facade.queue.start();
        facade.workerRunning = true;
      },
      onIdle: async () => facade.queue.onIdle(),
      close: async (options?: { drain?: boolean }) => {
        await facade.queue.close(options);
        facade.memoryScheduler?.close();
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
    const source = this.queue as {
      on(
        event: keyof QueueEventMap,
        listener: (payload: QueueEventMap[keyof QueueEventMap]) => void
      ): () => void;
    };
    for (const event of events) {
      source.on(event, (payload: QueueEventMap[keyof QueueEventMap]) => {
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

  private addLegacy(
    name: string,
    value: unknown,
    options: LegacyAddOptions
  ): LegacyJob {
    if (this.redis) {
      return this.redis.add(
        name,
        value,
        options as RedisAddOptions
      );
    }
    return (this.memory as MemoryQueue<RuntimeJobMap>).add(
      name,
      value,
      options
    );
  }
}

export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options?: MemoryEnqiuOptions
): JobsApi<Definitions>;
export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options: RedisEnqiuOptions
): JobsApi<Definitions>;
export function enqiu<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  options: EnqiuOptions = {}
): JobsApi<Definitions> {
  return new EnqiuFacade(definitions, options).api;
}

function normalizeDefinition(definition: JobDefinition): NormalizedDefinition {
  if (typeof definition === "function") {
    return {
      schema: undefined,
      run: definition as JobHandler,
      policy: {},
    };
  }
  if (
    !definition ||
    typeof definition !== "object" ||
    definition[definitionMarker] !== true
  ) {
    throw new TypeError(
      "Every job must be a handler or a definition created with job()"
    );
  }
  const {
    input,
    run,
    retry,
    timeout,
    expiresIn,
    concurrency,
    throttle,
    debounce,
  } = definition;
  return {
    schema: input,
    run: run as JobHandler,
    policy: compact({
      retry,
      timeout,
      expiresIn,
      concurrency,
      throttle,
      debounce,
    }),
  };
}

async function validateInput(
  name: string,
  schema: StandardSchemaV1 | undefined,
  input: unknown
): Promise<unknown> {
  if (!schema) {
    return input;
  }
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    throw new JobValidationError(name, result.issues);
  }
  return result.value;
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const standard = (value as Partial<StandardSchemaV1>)["~standard"];
  return (
    standard?.version === 1 &&
    typeof standard.vendor === "string" &&
    typeof standard.validate === "function"
  );
}

function normalizeLegacyRetry(
  value: number | RetryPolicy | undefined
): number | RetryOptions | undefined {
  if (typeof value === "number" || value === undefined) {
    return value;
  }
  if (!Number.isInteger(value.attempts) || value.attempts < 1) {
    throw new RangeError("retry.attempts must be a positive integer");
  }
  return compact({
    retries: value.attempts - 1,
    backoff: value.backoff,
    when: value.when,
  });
}

function toLegacyOptions(
  options: SubmitOptions,
  policy: JobPolicyOptions<unknown>,
  name: string,
  input: unknown
): LegacyAddOptions {
  const priority =
    typeof options.priority === "string"
      ? { low: -10, normal: 0, high: 10 }[options.priority]
      : options.priority;
  const concurrency =
    policy.concurrency === undefined
      ? undefined
      : typeof policy.concurrency === "number"
        ? {
            limit: policy.concurrency,
            key: `${name}:*`,
          }
        : {
            limit: policy.concurrency.limit,
            key: `${name}:${resolvePolicyKey(
              "concurrency.by",
              policy.concurrency.by?.(input) ?? "*"
            )}`,
          };
  const throttle = policy.throttle
    ? {
        limit: policy.throttle.limit,
        interval: policy.throttle.per,
        burst: policy.throttle.burst ?? policy.throttle.limit,
        key: `${name}:${resolvePolicyKey(
          "throttle.by",
          policy.throttle.by?.(input) ?? "*"
        )}`,
      }
    : undefined;
  const debounce = policy.debounce
    ? {
        wait: policy.debounce.wait,
        mode: policy.debounce.mode,
        key: resolvePolicyKey(
          "debounce.by",
          policy.debounce.by(input)
        ),
      }
    : undefined;
  return compact({
    id: options.id,
    key: options.idempotencyKey,
    keyRetention: options.idempotencyKey
      ? options.idempotencyTtl ?? 24 * 60 * 60 * 1000
      : undefined,
    delay: options.delay,
    priority,
    retry: normalizeLegacyRetry(options.retry ?? policy.retry),
    timeout: options.timeout ?? policy.timeout,
    expiresIn: options.expiresIn ?? policy.expiresIn,
    concurrency,
    throttle,
    debounce,
    signal: options.signal,
  });
}

function resolvePolicyKey(name: string, value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must return a non-empty string`);
  }
  return value;
}

function createContext(
  legacy: LegacyJobContext,
  queue: string,
  telemetry: Telemetry | undefined
): JobContext {
  const log = createLogger(legacy, queue, telemetry);
  return {
    id: legacy.id,
    name: legacy.name,
    attempt: legacy.attempt,
    signal: legacy.signal,
    reportProgress: async (progress: Progress) => {
      validateProgress(progress);
      const safeProgress = cloneJobValue(progress);
      legacy.progress(safeProgress);
      telemetry?.emit({
        type: "job.progress",
        queue,
        timestamp: Date.now(),
        fields: {
          jobId: legacy.id,
          jobName: legacy.name,
          progress: safeProgress,
        },
      });
    },
    log,
  };
}

function createLogger(
  context: LegacyJobContext,
  queue: string,
  telemetry: Telemetry | undefined
): JobLogger {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Readonly<Record<string, unknown>>
  ): void => {
    if (!message) {
      throw new TypeError("Job log messages must not be empty");
    }
    const entry = cloneJobValue({
      timestamp: Date.now(),
      level,
      message,
      ...(fields === undefined ? {} : { fields }),
    });
    context.log(entry);
    telemetry?.emit({
      type: `job.log.${level}`,
      queue,
      timestamp: Date.now(),
      fields: {
        jobId: context.id,
        jobName: context.name,
        message: entry.message,
        ...(entry.fields ?? {}),
      },
    });
  };
  return Object.freeze({
    debug: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("debug", message, fields),
    info: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("info", message, fields),
    warn: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("warn", message, fields),
    error: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("error", message, fields),
  });
}

function validateProgress(progress: Progress): void {
  if (
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    progress.completed < 0 ||
    progress.total <= 0 ||
    progress.completed > progress.total
  ) {
    throw new RangeError(
      "Progress requires 0 <= completed <= total and total > 0"
    );
  }
}

type Compact<T> = {
  [Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key];
} & {
  [Key in keyof T as undefined extends T[Key] ? Key : never]?:
    Exclude<T[Key], undefined>;
};

function compact<T extends Record<PropertyKey, unknown>>(
  value: T
): Compact<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Compact<T>;
}

export {
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobSerializationError,
  JobTimeoutError,
  QueueClosedError,
};
