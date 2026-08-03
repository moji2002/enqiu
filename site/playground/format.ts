import type { JobSnapshot, JobStatus } from "enqiu";

export function statusLabel(status: JobStatus): string {
  const labels: Record<JobStatus, string> = {
    queued: "Queued",
    scheduled: "Scheduled",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    expired: "Expired",
  };
  return labels[status];
}

export function progressOf(job: JobSnapshot): number {
  if (job.status === "succeeded") return 100;
  if (!job.progress || typeof job.progress !== "object") return 0;
  const progress = job.progress as { completed?: unknown; total?: unknown };
  const completed = Number(progress.completed ?? 0);
  const total = Number(progress.total ?? 0);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export function progressMessage(job: JobSnapshot): string | undefined {
  if (!job.progress || typeof job.progress !== "object") return undefined;
  const message = (job.progress as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

export function formatClock(timestamp: number | undefined): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return formatClock(timestamp);
}

export function formatDuration(job: JobSnapshot): string {
  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? Date.now();
  const duration = Math.max(0, end - start);
  if (duration < 1_000) return `${duration}ms`;
  return `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`;
}

export function shortId(id: string): string {
  const parts = id.split(":");
  const tail = parts.length >= 4
    ? parts.slice(-2).join(":")
    : parts.at(-1) ?? id;
  return tail.length > 12 ? `${tail.slice(0, 8)}…` : tail;
}

export function prettyJson(value: unknown): string {
  if (value === undefined) return "No value yet";
  return JSON.stringify(value, null, 2);
}
