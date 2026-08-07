/**
 * Everything that translates between BullMQ's vocabulary and Enqiu's.
 *
 * Pure, and the one part of the library that can be tested without a Redis:
 * every other path goes through BullMQ. It lives in one place because the four
 * directions — reading a state back, listing, cleaning, and counting — used to
 * be four hand-written mappings, and they disagreed with each other.
 */

import type { Job as BullJob, JobState, JobsOptions } from "bullmq";
import type { QueueEventsListener } from "bullmq";
import { decodeFailure, failureToError } from "./errors.js";
import type {
  JobPolicyOptions,
  JobSnapshot,
  JobStatus,
  QueueEventMap,
  RetryPolicy,
  SubmitOptions,
} from "./types.js";

/**
 * Which BullMQ states make up each Enqiu status.
 *
 * `cancelled` maps to nothing: BullMQ has no state for it, so it lists and
 * cleans as empty and the marker hash is the only record.
 */
export const bullStates = {
  queued: ["waiting", "prioritized"],
  scheduled: ["delayed"],
  running: ["active"],
  succeeded: ["completed"],
  failed: ["failed"],
  cancelled: [],
} as const satisfies Record<JobStatus, readonly JobState[]>;

export const everyState: readonly JobState[] = Object.values(bullStates).flat();

const statusByState = new Map<string, JobStatus>(
  Object.entries(bullStates).flatMap(([status, states]) =>
    states.map((state) => [state, status as JobStatus] as const)
  )
);

/** BullMQ's states, mapped onto Enqiu's vocabulary. */
export function toStatus(state: string): JobStatus {
  return statusByState.get(state) ?? "queued";
}

/**
 * The single type `Queue.clean` accepts for a status.
 *
 * One per call is BullMQ's limit, so a status backed by several states cleans
 * its first. `cancelled` has none, and cleans only its markers.
 */
export function cleanTypeFor(status: JobStatus) {
  return bullStates[status][0];
}

/**
 * Enqiu's events, and the BullMQ event that carries each.
 *
 * `state` is what the event itself proves about the job, which saves asking
 * Redis for a state the notification already carried — and is the more
 * faithful answer besides, since a subscriber wants the state at the time of
 * the event rather than whatever it has become since. `added` proves only that
 * the job exists, not whether it was delayed or prioritized.
 */
export const queueEventMap = {
  added: { name: "added", state: undefined },
  started: { name: "active", state: "active" },
  progress: { name: "progress", state: "active" },
  succeeded: { name: "completed", state: "completed" },
  failed: { name: "failed", state: "failed" },
  error: { name: "error", state: undefined },
} as const satisfies Record<
  keyof QueueEventMap,
  { name: keyof QueueEventsListener; state: JobState | undefined }
>;

export function toSnapshot(bull: BullJob, status: JobStatus): JobSnapshot {
  const snapshot: JobSnapshot = {
    id: String(bull.id),
    name: bull.name,
    input: bull.data,
    status,
    attempt: bull.attemptsMade,
    createdAt: bull.timestamp,
  };
  if (bull.processedOn) snapshot.startedAt = bull.processedOn;
  if (bull.finishedOn) snapshot.finishedAt = bull.finishedOn;
  if (bull.progress !== undefined && bull.progress !== 0) {
    snapshot.progress = bull.progress;
  }
  if (bull.returnvalue !== undefined && bull.returnvalue !== null) {
    snapshot.output = bull.returnvalue;
  }
  if (bull.failedReason) {
    // A timeout or an expiry wrote down which it was, so the snapshot can name
    // the error rather than calling everything "Error".
    const failure = decodeFailure(bull.failedReason);
    const error = failure ? failureToError(failure) : undefined;
    snapshot.error = error
      ? { name: error.name, message: error.message }
      : { name: "Error", message: bull.failedReason };
  }
  return snapshot;
}

// BullMQ orders ascending: a lower number runs sooner.
const priorities = { high: 1, normal: 2, low: 3 };

export interface SubmitDefaults {
  readonly logLimit: number;
  readonly retry: number | RetryPolicy | undefined;
}

/** Options BullMQ can carry across the queue, resolved submit → job → queue. */
export function toJobsOptions(
  options: SubmitOptions,
  policy: JobPolicyOptions,
  defaults: SubmitDefaults
): JobsOptions {
  const jobsOptions: JobsOptions = { keepLogs: defaults.logLimit };

  if (options.id !== undefined) jobsOptions.jobId = options.id;
  if (options.delay !== undefined) {
    jobsOptions.delay =
      options.delay instanceof Date
        ? Math.max(0, options.delay.getTime() - Date.now())
        : options.delay;
  }
  if (options.priority !== undefined) {
    jobsOptions.priority =
      typeof options.priority === "string"
        ? priorities[options.priority]
        : options.priority;
  }
  if (options.idempotencyKey !== undefined) {
    jobsOptions.deduplication = { id: options.idempotencyKey };
    if (options.idempotencyTtl !== undefined) {
      jobsOptions.deduplication.ttl = options.idempotencyTtl;
    }
  }

  const retry = options.retry ?? policy.retry ?? defaults.retry;
  if (retry !== undefined) {
    const attempts = typeof retry === "number" ? retry + 1 : retry.attempts;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError("retry.attempts must be a positive integer");
    }
    jobsOptions.attempts = attempts;
    const backoff = typeof retry === "number" ? undefined : retry.backoff;
    if (backoff !== undefined) {
      jobsOptions.backoff =
        typeof backoff === "number"
          ? backoff
          : { type: backoff.type ?? "fixed", delay: backoff.delay };
    }
  }
  return jobsOptions;
}

/**
 * One offset per underlying state, because BullMQ ranges over each separately.
 *
 * A single number would mean "position within each state", which skips and
 * repeats jobs the moment a status spans more than one of them.
 */
export function decodeCursor(
  cursor: string | undefined,
  states: number
): number[] {
  if (cursor === undefined) return new Array<number>(states).fill(0);
  const offsets = cursor.split(".").map((part) => Number.parseInt(part, 10));
  const usable =
    offsets.length === states &&
    offsets.every((offset) => Number.isInteger(offset) && offset >= 0);
  if (!usable) throw new TypeError("Invalid list cursor");
  return offsets;
}

export function encodeCursor(offsets: readonly number[]): string {
  return offsets.join(".");
}

/** What one BullMQ state contributed to a page, and where it was read from. */
export interface StatePage<T> {
  readonly offset: number;
  readonly items: readonly T[];
}

/**
 * Take one page's worth across the states, and say where each got to.
 *
 * Pure on purpose. This is the arithmetic a single-number cursor got wrong, and
 * leaving it inside the async method that fetches the states put it out of
 * reach of every test that runs without a server.
 *
 * Offsets arrive attached to their items rather than as a second array: they
 * are only ever meaningful in pairs, and two arrays could disagree in length
 * with nothing to catch it.
 */
export function mergePage<T>(
  pages: readonly StatePage<T>[],
  limit: number
): { items: T[]; next: number[] } {
  const items: T[] = [];
  const next: number[] = [];
  for (const page of pages) {
    let taken = 0;
    for (const item of page.items) {
      if (items.length === limit) break;
      items.push(item);
      taken += 1;
    }
    next.push(page.offset + taken);
  }
  return { items, next };
}
