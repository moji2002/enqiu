/** Errors a job can settle with, and how a reason survives the queue. */

export interface SerializedError {
  name: string;
  message: string;
}

export class JobFailedError extends Error {
  readonly jobId: string;

  constructor(jobId: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JobFailedError";
    this.jobId = jobId;
  }
}

export class JobCancelledError extends Error {
  readonly jobId: string;

  constructor(jobId: string, message = "Job was cancelled") {
    super(message);
    this.name = "JobCancelledError";
    this.jobId = jobId;
  }
}

export class JobTimeoutError extends Error {
  readonly jobId: string;
  readonly timeout: number;

  constructor(jobId: string, timeout: number) {
    super(`Job "${jobId}" timed out after ${timeout}ms`);
    this.name = "JobTimeoutError";
    this.jobId = jobId;
    this.timeout = timeout;
  }
}

export class JobExpiredError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job "${jobId}" expired before it could start`);
    this.name = "JobExpiredError";
    this.jobId = jobId;
  }
}

export class QueueClosedError extends Error {
  constructor(name: string) {
    super(`Queue "${name}" is closed`);
    this.name = "QueueClosedError";
  }
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

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?:
    | ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
    | undefined;
}

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/* -------------------------------------------------------------------------- */

/**
 * Why a job failed, in a form that survives the trip through Redis.
 *
 * BullMQ stores one string per failure, `failedReason`, and hands it to other
 * processes as a plain `Error`. So the reason has to travel as text — but not
 * as prose. Reading the kind back out of a human sentence means rewording that
 * sentence silently changes which class callers catch, with no test to notice;
 * this codebase has already been bitten by exactly that once. The kind is
 * therefore written down, and only the message is prose.
 */
export type JobFailure =
  | { readonly kind: "timeout"; readonly jobId: string; readonly timeout: number }
  | { readonly kind: "expired"; readonly jobId: string };

const FAILURE_PREFIX = "enqiu-failure:";

export function encodeFailure(failure: JobFailure): string {
  return FAILURE_PREFIX + JSON.stringify(failure);
}

export function decodeFailure(reason: string): JobFailure | undefined {
  if (!reason.startsWith(FAILURE_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(reason.slice(FAILURE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { kind, jobId, timeout } = parsed as Record<string, unknown>;
  if (typeof jobId !== "string") return undefined;
  if (kind === "expired") return { kind, jobId };
  if (kind === "timeout" && typeof timeout === "number") {
    return { kind, jobId, timeout };
  }
  return undefined;
}

export function failureToError(failure: JobFailure): Error {
  return failure.kind === "timeout"
    ? new JobTimeoutError(failure.jobId, failure.timeout)
    : new JobExpiredError(failure.jobId);
}
