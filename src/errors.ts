/** Errors a job can settle with. */

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
