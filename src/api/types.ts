/** The public vocabulary of `enqiu()`, plus the `job()` definition helper. */

import type {
  JobSnapshot,
  JobStatus,
  MaybePromise,
  QueueEventMap,
  QueueStats,
  RetryOptions,
} from "../memory.js";
import type {
  DriverFactory,
  ScheduleHandle,
} from "../driver.js";

export type { ScheduleHandle, ScheduleSnapshot } from "../driver.js";


export const definitionMarker = Symbol("enqiu.job");
export const reservedNames = new Set(["queue", "worker"]);

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

export interface NormalizedDefinition {
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
