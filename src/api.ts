import {
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
} from "./memory.js";
import type {
  AddOptions,
  JobContext as HandlerContext,
  JobSnapshot,
  JobStatus,
  MaybePromise,
  QueueEventMap,
  QueueStats,
  RetryOptions,
} from "./memory.js";
import type {
  DriverFactory,
  DriverHandlers,
  DriverJob,
  DriverQueueOptions,
  QueueDriver,
  ScheduleHandle,
} from "./driver.js";
import { createMemoryDriver } from "./drivers/memory.js";
import {
  JobSerializationError,
  cloneJobValue,
} from "./codec.js";
import { compact } from "./internal/object.js";

export type { ScheduleHandle, ScheduleSnapshot } from "./driver.js";

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
  | HandlerJobDefinition<never, unknown>;

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

export interface DriverEnqiuOptions extends SharedEnqiuOptions {
  /** A driver factory, such as the one returned by `redis(client)`. */
  driver: DriverFactory;
  /** Shared backends must explicitly choose producer-only or worker mode. */
  worker: false | WorkerOptions;
}

export type EnqiuOptions = MemoryEnqiuOptions | DriverEnqiuOptions;

interface NormalizedDefinition {
  schema: StandardSchemaV1 | undefined;
  run: JobHandler;
  policy: JobPolicyOptions<unknown>;
}

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

function normalizeRetryPolicy(
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

function toAddOptions(
  options: SubmitOptions,
  policy: JobPolicyOptions<unknown>,
  name: string,
  input: unknown
): AddOptions {
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
    retry: normalizeRetryPolicy(options.retry ?? policy.retry),
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
  handler: HandlerContext,
  queue: string,
  telemetry: Telemetry | undefined
): JobContext {
  const log = createLogger(handler, queue, telemetry);
  return {
    id: handler.id,
    name: handler.name,
    attempt: handler.attempt,
    signal: handler.signal,
    reportProgress: async (progress: Progress) => {
      validateProgress(progress);
      const safeProgress = cloneJobValue(progress);
      handler.progress(safeProgress);
      telemetry?.emit({
        type: "job.progress",
        queue,
        timestamp: Date.now(),
        fields: {
          jobId: handler.id,
          jobName: handler.name,
          progress: safeProgress,
        },
      });
    },
    log,
  };
}

function createLogger(
  context: HandlerContext,
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

export {
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobSerializationError,
  JobTimeoutError,
  QueueClosedError,
};
