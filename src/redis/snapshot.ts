/** Conversion between Redis hash fields and JobSnapshot. */

import { decodeJobValue as decode } from "../codec.js";
import type { JobLogEntry, JobSnapshot, JobStatus } from "../memory.js";
import type { SerializedError } from "../internal/errors.js";
import type { RedisJobRecord, RedisQueueEventMap } from "./types.js";

function optionalNumber(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

export function snapshotFromFields(values: unknown[]): JobSnapshot {
  const text = (index: number): string =>
    values[index] === null || values[index] === undefined
      ? ""
      : String(values[index]);
  return {
    id: text(0),
    name: text(1),
    input: decode(text(2)),
    status: text(3) as JobStatus,
    priority: Number(text(4)),
    attempt: Number(text(5)),
    retries: Number(text(6)),
    createdAt: Number(text(7)),
    runAt: Number(text(8)),
    expiresAt: optionalNumber(text(9)),
    startedAt: optionalNumber(text(10)),
    finishedAt: optionalNumber(text(11)),
    progress: text(12) ? decode(text(12)) : undefined,
    output: text(13) ? decode(text(13)) : undefined,
    error: text(14)
      ? (JSON.parse(text(14)) as SerializedError)
      : undefined,
    logs: text(15)
      ? (decode(text(15)) as JobLogEntry[])
      : [],
  };
}

export function applySnapshot(
  record: RedisJobRecord,
  value: JobSnapshot
): void {
  record.id = value.id;
  record.name = value.name;
  record.input = value.input;
  record.status = value.status;
  record.priority = value.priority;
  record.attempt = value.attempt;
  record.createdAt = value.createdAt;
  record.runAt = value.runAt;
  record.expiresAt = value.expiresAt;
  record.startedAt = value.startedAt;
  record.finishedAt = value.finishedAt;
  record.progress = value.progress;
  record.output = value.output;
  record.error = value.error;
  record.logs = [...(value.logs ?? [])];
}

export function snapshotForEvent(
  type: keyof RedisQueueEventMap,
  snapshot: JobSnapshot,
  timestamp: number
): JobSnapshot {
  if (type === "added") {
    return {
      ...snapshot,
      status: snapshot.runAt > timestamp ? "scheduled" : "queued",
    };
  }
  if (type === "started") {
    return { ...snapshot, status: "running", startedAt: timestamp };
  }
  if (type === "retry" || type === "recovered") {
    return {
      ...snapshot,
      status: snapshot.runAt > timestamp ? "scheduled" : "queued",
    };
  }
  if (
    type === "succeeded" ||
    type === "failed" ||
    type === "cancelled" ||
    type === "expired"
  ) {
    return { ...snapshot, status: type, finishedAt: timestamp };
  }
  return snapshot;
}
