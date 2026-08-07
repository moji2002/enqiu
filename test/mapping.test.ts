/**
 * The vocabulary translation, tested without a Redis.
 *
 * Everything else in Enqiu goes through BullMQ and needs a live server. This
 * does not, and it is where the mappings that used to disagree with each other
 * live, so it is worth pinning precisely.
 */

import type { Job as BullJob } from "bullmq";
import { describe, expect, it } from "vitest";
import {
  bullStates,
  cleanTypeFor,
  decodeCursor,
  encodeCursor,
  everyState,
  queueEventMap,
  toJobsOptions,
  toSnapshot,
  toStatus,
} from "../src/mapping.js";
import {
  JobExpiredError,
  JobTimeoutError,
  decodeFailure,
  encodeFailure,
  failureToError,
} from "../src/errors.js";
import type { JobStatus } from "../src/types.js";

const noDefaults = { logLimit: 100, retry: undefined };

const asJob = (fields: Partial<BullJob>): BullJob =>
  ({
    id: "1",
    name: "work",
    data: { a: 1 },
    attemptsMade: 0,
    timestamp: 1_000,
    ...fields,
  }) as BullJob;

describe("status table", () => {
  const statuses: JobStatus[] = [
    "queued",
    "scheduled",
    "running",
    "succeeded",
    "failed",
    "cancelled",
  ];

  it("covers every status exactly once, with no state claimed twice", () => {
    expect(Object.keys(bullStates).sort()).toEqual([...statuses].sort());
    expect(new Set(everyState).size).toBe(everyState.length);
  });

  it("round-trips every mapped state back to its status", () => {
    for (const status of statuses) {
      for (const state of bullStates[status]) {
        expect(toStatus(state)).toBe(status);
      }
    }
  });

  it("treats states it does not model as queued", () => {
    expect(toStatus("waiting-children")).toBe("queued");
    expect(toStatus("unknown")).toBe("queued");
  });

  it("gives cancelled no BullMQ state to list or clean", () => {
    expect(bullStates.cancelled).toEqual([]);
    expect(cleanTypeFor("cancelled")).toBeUndefined();
  });

  it("cleans each status through a type BullMQ accepts", () => {
    expect(cleanTypeFor("queued")).toBe("waiting");
    expect(cleanTypeFor("scheduled")).toBe("delayed");
    expect(cleanTypeFor("running")).toBe("active");
    expect(cleanTypeFor("succeeded")).toBe("completed");
    expect(cleanTypeFor("failed")).toBe("failed");
  });

  it("names a BullMQ event for every Enqiu event", () => {
    expect(queueEventMap.succeeded).toEqual({
      name: "completed",
      state: "completed",
    });
    // `added` cannot claim a state: the job may have been delayed.
    expect(queueEventMap.added.state).toBeUndefined();
  });
});

describe("failure envelope", () => {
  it("round-trips the kinds Enqiu enforces itself", () => {
    const timeout = { kind: "timeout", jobId: "7", timeout: 60 } as const;
    expect(decodeFailure(encodeFailure(timeout))).toEqual(timeout);

    const expired = { kind: "expired", jobId: "7" } as const;
    expect(decodeFailure(encodeFailure(expired))).toEqual(expired);
  });

  it("rebuilds the error class the kind names", () => {
    expect(
      failureToError({ kind: "timeout", jobId: "7", timeout: 60 })
    ).toBeInstanceOf(JobTimeoutError);
    expect(failureToError({ kind: "expired", jobId: "7" })).toBeInstanceOf(
      JobExpiredError
    );
  });

  it("leaves anything it did not write alone", () => {
    // A handler's own failure is prose, and must stay prose.
    expect(decodeFailure("banking partner unreachable")).toBeUndefined();
    expect(decodeFailure("")).toBeUndefined();
  });

  it("refuses its own prefix on something malformed", () => {
    expect(decodeFailure("enqiu-failure:{oops")).toBeUndefined();
    expect(decodeFailure("enqiu-failure:null")).toBeUndefined();
    expect(decodeFailure('enqiu-failure:"a string"')).toBeUndefined();
    // Right prefix, unknown kind, or a kind missing what it needs.
    expect(decodeFailure('enqiu-failure:{"kind":"nope","jobId":"7"}')).toBeUndefined();
    expect(decodeFailure('enqiu-failure:{"kind":"timeout","jobId":"7"}')).toBeUndefined();
    expect(decodeFailure('enqiu-failure:{"kind":"expired"}')).toBeUndefined();
  });
});

describe("cursor", () => {
  it("starts at zero for every state", () => {
    expect(decodeCursor(undefined, 2)).toEqual([0, 0]);
  });

  it("round-trips one offset per state", () => {
    expect(decodeCursor(encodeCursor([4, 7]), 2)).toEqual([4, 7]);
  });

  it("rejects a cursor that does not match the states asked for", () => {
    expect(() => decodeCursor("1", 2)).toThrow("Invalid list cursor");
    expect(() => decodeCursor("1.2.3", 2)).toThrow("Invalid list cursor");
    expect(() => decodeCursor("nope", 1)).toThrow("Invalid list cursor");
    expect(() => decodeCursor("-1", 1)).toThrow("Invalid list cursor");
  });
});

describe("job options", () => {
  it("keeps the configured number of log lines", () => {
    expect(toJobsOptions({}, {}, { logLimit: 5, retry: undefined })).toEqual({
      keepLogs: 5,
    });
  });

  it("turns a named priority into BullMQ's ascending number", () => {
    expect(toJobsOptions({ priority: "high" }, {}, noDefaults).priority).toBe(1);
    expect(toJobsOptions({ priority: "low" }, {}, noDefaults).priority).toBe(3);
    expect(toJobsOptions({ priority: 9 }, {}, noDefaults).priority).toBe(9);
  });

  it("turns a Date delay into a duration, never a negative one", () => {
    const future = toJobsOptions(
      { delay: new Date(Date.now() + 60_000) },
      {},
      noDefaults
    );
    expect(future.delay).toBeGreaterThan(50_000);
    expect(
      toJobsOptions({ delay: new Date(Date.now() - 60_000) }, {}, noDefaults)
        .delay
    ).toBe(0);
  });

  it("counts a retry number as attempts after the first", () => {
    expect(toJobsOptions({ retry: 2 }, {}, noDefaults).attempts).toBe(3);
    expect(
      toJobsOptions({ retry: { attempts: 2, backoff: 10 } }, {}, noDefaults)
    ).toMatchObject({ attempts: 2, backoff: 10 });
    expect(
      toJobsOptions(
        { retry: { attempts: 2, backoff: { delay: 10 } } },
        {},
        noDefaults
      ).backoff
    ).toEqual({ type: "fixed", delay: 10 });
  });

  it("resolves retry submit → job → queue", () => {
    const queueDefault = { logLimit: 100, retry: 1 };
    expect(toJobsOptions({}, {}, queueDefault).attempts).toBe(2);
    expect(toJobsOptions({}, { retry: 3 }, queueDefault).attempts).toBe(4);
    expect(toJobsOptions({ retry: 5 }, { retry: 3 }, queueDefault).attempts).toBe(
      6
    );
  });

  it("refuses an attempt count that cannot mean anything", () => {
    expect(() => toJobsOptions({ retry: { attempts: 0 } }, {}, noDefaults)).toThrow(
      "retry.attempts must be a positive integer"
    );
  });

  it("carries an idempotency key and its ttl", () => {
    expect(
      toJobsOptions({ idempotencyKey: "k", idempotencyTtl: 50 }, {}, noDefaults)
        .deduplication
    ).toEqual({ id: "k", ttl: 50 });
  });
});

describe("snapshots", () => {
  it("reports only the fields the job actually has", () => {
    expect(toSnapshot(asJob({}), "queued")).toEqual({
      id: "1",
      name: "work",
      input: { a: 1 },
      status: "queued",
      attempt: 0,
      createdAt: 1_000,
    });
  });

  it("includes progress, output and timings once they exist", () => {
    const snapshot = toSnapshot(
      asJob({
        processedOn: 2_000,
        finishedOn: 3_000,
        progress: { completed: 1, total: 2 },
        returnvalue: { ok: true },
      }),
      "succeeded"
    );
    expect(snapshot).toMatchObject({
      startedAt: 2_000,
      finishedAt: 3_000,
      progress: { completed: 1, total: 2 },
      output: { ok: true },
    });
  });

  it("names the error a timeout or an expiry wrote down", () => {
    expect(
      toSnapshot(
        asJob({
          failedReason: encodeFailure({
            kind: "timeout",
            jobId: "1",
            timeout: 60,
          }),
        }),
        "failed"
      ).error
    ).toEqual({
      name: "JobTimeoutError",
      message: 'Job "1" timed out after 60ms',
    });

    expect(
      toSnapshot(
        asJob({ failedReason: encodeFailure({ kind: "expired", jobId: "1" }) }),
        "failed"
      ).error?.name
    ).toBe("JobExpiredError");
  });

  it("passes a handler's own failure through as written", () => {
    expect(
      toSnapshot(asJob({ failedReason: "banking partner down" }), "failed").error
    ).toEqual({ name: "Error", message: "banking partner down" });
  });
});
