import type { JobSnapshot } from "enqiu";
import {
  formatClock,
  formatRelative,
  progressMessage,
  progressOf,
  shortId,
  statusLabel,
} from "../format";
import { cn } from "../lib/utils";

const statusTone: Record<JobSnapshot["status"], string> = {
  queued: "bg-amber-400",
  scheduled: "bg-violet-500",
  running: "bg-blue-500",
  succeeded: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-neutral-400",
  expired: "bg-orange-500",
};

function priorityLabel(priority: number): string | undefined {
  if (priority > 0) return "High";
  if (priority < 0) return "Low";
  return undefined;
}

export function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: JobSnapshot;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const progress = progressOf(job);
  const message = progressMessage(job);
  const delay =
    job.status === "scheduled"
      ? `Runs ${formatClock(job.runAt)}`
      : undefined;
  const priority = priorityLabel(job.priority);

  return (
    <li>
      <button
        className="grid min-h-[72px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-blue-500 aria-current:bg-blue-50/70 dark:hover:bg-neutral-900 dark:aria-current:bg-blue-950/30 sm:grid-cols-[auto_minmax(0,1.2fr)_minmax(100px,0.8fr)_100px_auto]"
        type="button"
        aria-current={selected ? "true" : undefined}
        data-status={job.status}
        onClick={() => onSelect(job.id)}
      >
        <span className="grid size-9 place-items-center rounded-md border border-neutral-200 bg-neutral-50 font-mono text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900" aria-hidden="true">
          J
        </span>
        <span className="min-w-0">
          <strong className="block truncate font-mono text-xs font-medium text-black dark:text-white">{job.name}()</strong>
          <small className="mt-1 block truncate font-mono text-[10px] text-neutral-500">{shortId(job.id)}</small>
        </span>
        <span className="col-start-2 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
          <span className="flex items-center gap-1.5">
            <span className={cn("size-1.5 shrink-0 rounded-full", statusTone[job.status])} aria-hidden="true" />
            <strong className="truncate text-xs font-medium">{statusLabel(job.status)}</strong>
          </span>
          <small className="mt-1 block truncate text-[10px] text-neutral-500">{message ?? `Attempt ${Math.max(1, job.attempt)}`}</small>
        </span>
        <span className="hidden items-center gap-2 sm:flex" aria-label={`${progress}% complete`}>
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"><i className="block h-full rounded-full bg-blue-500 transition-[width] duration-300" style={{ width: `${progress}%` }} /></span>
          <small className="w-7 text-right font-mono text-[10px] text-neutral-500">{progress}%</small>
        </span>
        <span className="col-start-3 row-span-2 row-start-1 text-right sm:col-start-auto sm:row-span-1 sm:row-start-auto">
          <time className="block font-mono text-[10px] text-neutral-600 dark:text-neutral-400" dateTime={new Date(job.createdAt).toISOString()}>
            {formatRelative(job.createdAt)}
          </time>
          {delay || priority ? <small className="mt-1 block max-w-24 text-[10px] text-neutral-500">{delay ?? `${priority} priority`}</small> : null}
        </span>
      </button>
    </li>
  );
}
