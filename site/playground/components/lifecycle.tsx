import type { JobSnapshot } from "enqiu";
import {
  formatClock,
  progressMessage,
  statusLabel,
} from "../format";

interface LifecycleEntry {
  label: string;
  detail: string;
  timestamp?: number;
  tone: "neutral" | "active" | "success" | "danger";
}

function entriesFor(job: JobSnapshot): LifecycleEntry[] {
  const entries: LifecycleEntry[] = [
    {
      label: "Accepted",
      detail: job.runAt > job.createdAt + 50 ? "Scheduled by Enqiu" : "Entered the queue",
      timestamp: job.createdAt,
      tone: "neutral",
    },
  ];
  if (job.runAt > job.createdAt + 50) {
    entries.push({
      label: "Scheduled",
      detail: `Run at ${formatClock(job.runAt)}`,
      timestamp: job.runAt,
      tone: job.status === "scheduled" ? "active" : "neutral",
    });
  }
  if (job.startedAt) {
    entries.push({
      label: `Attempt ${Math.max(1, job.attempt)}`,
      detail: progressMessage(job) ?? "Handler started",
      timestamp: job.startedAt,
      tone: job.status === "running" ? "active" : "neutral",
    });
  }
  if (job.attempt > 1) {
    entries.splice(Math.max(1, entries.length - 1), 0, {
      label: "Retried",
      detail: `${job.attempt - 1} earlier attempt${job.attempt > 2 ? "s" : ""}`,
      tone: "neutral",
    });
  }
  if (["succeeded", "failed", "cancelled", "expired"].includes(job.status)) {
    entries.push({
      label: statusLabel(job.status),
      detail:
        job.status === "failed"
          ? job.error?.message ?? "Handler failed"
          : job.status === "cancelled"
            ? "Cancellation completed"
            : job.status === "expired"
              ? "Expired before execution"
              : "Result retained in history",
      timestamp: job.finishedAt,
      tone: job.status === "succeeded" ? "success" : "danger",
    });
  }
  return entries;
}

export function Lifecycle({ job }: { job: JobSnapshot }) {
  return (
    <ol className="lifecycle">
      {entriesFor(job).map((entry, index) => (
        <li key={`${entry.label}-${index}`} data-tone={entry.tone}>
          <i aria-hidden="true" />
          <div>
            <strong>{entry.label}</strong>
            <span>{entry.detail}</span>
          </div>
          <time>{entry.timestamp ? formatClock(entry.timestamp) : "—"}</time>
        </li>
      ))}
    </ol>
  );
}
