/** Errors a job can settle with, shared by every driver. */

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

/**
 * A job was submitted under an ID that already exists.
 *
 * Schedules rely on this being distinguishable: two workers reaching the same
 * cron tick both submit under the same deterministic occurrence ID, and the
 * loser must be able to tell "someone else already claimed this tick" from a
 * real failure. Matching on the message text instead would break silently the
 * day the wording changed, leaving the schedule stuck.
 */
export class DuplicateJobIdError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job ID "${jobId}" already exists`);
    this.name = "DuplicateJobIdError";
    this.jobId = jobId;
  }
}

export class QueueClosedError extends Error {
  constructor(name: string) {
    super(`Queue "${name}" is closed`);
    this.name = "QueueClosedError";
  }
}

/**
 * An awaitable handle returned synchronously by `queue.add()`.
 *
 * Ignoring a handle is safe: MemoryQueue does not create a rejecting promise until
 * the handle is awaited or `.result` is read.
 */
