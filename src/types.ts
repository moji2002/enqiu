/**
 * The public vocabulary of `enqiu()`.
 *
 * Enqiu is a typed layer over BullMQ: it owns inference and validation, BullMQ
 * owns storage and execution. Anything BullMQ's open-source tier cannot
 * express is absent here rather than faked — see the compatibility notes in
 * the README.
 */

import type { ConnectionOptions, Queue, Worker } from "bullmq";
import type { SerializedError, StandardSchemaIssue } from "./errors.js";

export type { SerializedError, StandardSchemaIssue } from "./errors.js";

export type MaybePromise<T> = T | PromiseLike<T>;

export const definitionMarker = Symbol("enqiu.job");

export type JobStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

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
    // The spec declares every optional property with an explicit `| undefined`.
    // Without it, Zod and friends fail to assign under
    // `exactOptionalPropertyTypes`.
    readonly types?:
      | { readonly input: Input; readonly output: Output }
      | undefined;
  };
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
> = (input: Input, context: JobContext<Name>) => MaybePromise<Output>;

export interface BackoffOptions {
  type?: "fixed" | "exponential";
  delay: number;
}

export interface RetryPolicy {
  /** Total number of attempts, including the first. */
  attempts: number;
  backoff?: number | BackoffOptions;
}

/**
 * Per-job policies.
 *
 * `timeout` and `expiresIn` are enforced by Enqiu around the handler, because
 * BullMQ has neither. Keyed concurrency, keyed throttling and debounce are not
 * here: BullMQ's open-source tier offers only a global per-worker rate limit,
 * and per-key grouping is a BullMQ Pro feature.
 */
export interface JobPolicyOptions {
  retry?: number | RetryPolicy;
  /** Per-attempt deadline. Aborts the handler's signal and fails the attempt. */
  timeout?: number;
  /** Fail without running if the job has waited longer than this. */
  expiresIn?: number;
}

export interface SchemaJobDefinition<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
  Output = unknown,
> extends JobPolicyOptions {
  readonly [definitionMarker]: true;
  readonly input: Schema;
  readonly run: JobHandler<InferSchemaOutput<Schema>, Output>;
}

export type HandlerJobDefinition<Input = unknown, Output = unknown> =
  JobHandler<Input, Output>;

/**
 * `any` is required in the schema position. JobHandler is contravariant in its
 * input and the generic is invariant in Schema, so pinning it rejects every
 * real schema and collapses the inferred API to `unknown`.
 */
export type JobDefinition =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | SchemaJobDefinition<any, any>
  | HandlerJobDefinition<never, unknown>;

export type JobDefinitions = Record<string, JobDefinition>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type DefinitionInput<Definition> =
  Definition extends SchemaJobDefinition<infer Schema, any>
    ? InferSchemaInput<Schema>
    : Definition extends JobHandler<infer Input, unknown, string>
      ? Input
      : never;

type DefinitionRunInput<Definition> =
  Definition extends SchemaJobDefinition<infer Schema, any>
    ? InferSchemaOutput<Schema>
    : Definition extends JobHandler<infer Input, unknown, string>
      ? Input
      : never;

type DefinitionOutput<Definition> =
  Definition extends SchemaJobDefinition<any, infer Output>
    ? Awaited<Output>
    : Definition extends JobHandler<unknown, infer Output, string>
      ? Awaited<Output>
      : never;

type DefinitionSchema<Definition> =
  Definition extends SchemaJobDefinition<infer Schema, any> ? Schema : undefined;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SubmitOptions {
  id?: string;
  /** Reuses an existing job with the same key instead of creating a new one. */
  idempotencyKey?: string;
  idempotencyTtl?: number;
  delay?: number | Date;
  priority?: number | "low" | "normal" | "high";
  retry?: number | RetryPolicy;
  timeout?: number;
  expiresIn?: number;
}

export interface BulkOptions extends Omit<SubmitOptions, "id"> {
  ids?: readonly string[];
}

export interface ScheduleOptions<Input> {
  id?: string;
  cron: string;
  timezone?: string;
  input: Input;
}

export interface ScheduleSnapshot {
  id: string;
  jobName: string;
  cron: string;
  timezone: string;
  nextRunAt: number;
  input: unknown;
}

export interface ScheduleHandle {
  readonly id: string;
  readonly nextRunAt: number;
  remove(): Promise<void>;
  refresh(): Promise<ScheduleSnapshot>;
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
  attempt: number;
  createdAt: number;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  progress?: unknown;
  output?: Output | undefined;
  error?: SerializedError | undefined;
  logs?: readonly string[] | undefined;
}

export interface JobHandle<
  Output = unknown,
  Input = unknown,
  Name extends string = string,
> {
  readonly id: string;
  readonly name: Name;
  readonly input: Input;
  /** State at the time the handle was created or last refreshed. */
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

export interface QueueStats {
  queued: number;
  scheduled: number;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
}

export interface JobListQuery {
  status?: JobStatus;
  limit?: number;
  cursor?: string;
}

export interface JobListPage<Job = JobSnapshot> {
  jobs: Job[];
  cursor?: string;
}

export interface CleanupQuery {
  status?: JobStatus;
  olderThan?: number;
  limit?: number;
}

export type AnyJobSnapshot<Definitions extends JobDefinitions> = {
  [Name in keyof Definitions]: JobSnapshot<
    DefinitionRunInput<Definitions[Name]>,
    DefinitionOutput<Definitions[Name]>,
    Extract<Name, string>
  >;
}[keyof Definitions];

export interface QueueEventMap {
  added: JobSnapshot;
  started: JobSnapshot;
  progress: JobSnapshot;
  succeeded: JobSnapshot;
  failed: JobSnapshot;
  error: Error;
}

export interface QueueApi<Definitions extends JobDefinitions> {
  get(id: string): Promise<AnyJobSnapshot<Definitions> | undefined>;
  list(query?: JobListQuery): Promise<JobListPage<AnyJobSnapshot<Definitions>>>;
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

export interface EnqiuOptions {
  /** Queue name. @default "default" */
  name?: string;
  /** Redis connection, passed straight to BullMQ. */
  connection: ConnectionOptions;
  /** Redis key namespace. */
  prefix?: string;
  /** Run handlers in this process. `false` makes it producer-only. */
  worker?: false | WorkerOptions;
  retry?: number | RetryPolicy;
  timeout?: number;
  /** Structured log lines retained per job. @default 100 */
  logLimit?: number;
  /**
   * Check that job inputs and results are storable before handing them over.
   *
   * Costs about 1.4us per job — roughly two thirds of this layer's total
   * overhead — and buys an error naming the exact path, rather than whatever
   * the serialiser says once the value is already on its way to Redis. Turn it
   * off if you have measured that it matters and trust your payloads.
   *
   * @default true
   */
  validatePayloads?: boolean;
  telemetry?: Telemetry;
}

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
  /**
   * The BullMQ objects underneath, unwrapped.
   *
   * Enqiu's own surface is the typed, validated path. Everything BullMQ can do
   * that Enqiu does not model — flows, Pro groups, metrics, raw options — is
   * reachable here without a fork, and calls through it cost nothing extra
   * because there is no layer in the way.
   */
  readonly bull: {
    readonly queue: Queue;
    readonly worker: Worker | undefined;
  };
};
