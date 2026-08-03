import type { JobSnapshot } from "enqiu";
import {
  formatClock,
  progressMessage,
  statusLabel,
} from "../format";
import { cn } from "../lib/utils";

const toneClass: Record<LifecycleEntry["tone"], string> = {
  neutral: "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950",
  active: "border-blue-500 bg-blue-500 shadow-[0_0_0_4px_rgb(59_130_246/0.12)]",
  success: "border-emerald-500 bg-emerald-500",
  danger: "border-red-500 bg-red-500",
};

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
  const entries = entriesFor(job);
  return (
    <ol className="mt-3 space-y-0">
      {entries.map((entry, index) => (
        <li className="relative grid grid-cols-[16px_1fr_auto] gap-2.5 pb-4 last:pb-0" key={`${entry.label}-${index}`}>
          {index < entries.length - 1 ? <i className="absolute left-[7px] top-3 h-full w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" /> : null}
          <i className={cn("relative z-10 mt-0.5 size-4 rounded-full border-4", toneClass[entry.tone])} aria-hidden="true" />
          <div className="min-w-0">
            <strong className="block text-xs font-medium">{entry.label}</strong>
            <span className="mt-0.5 block text-[11px] text-neutral-500">{entry.detail}</span>
          </div>
          <time className="font-mono text-[10px] text-neutral-500">{entry.timestamp ? formatClock(entry.timestamp) : "—"}</time>
        </li>
      ))}
    </ol>
  );
}
