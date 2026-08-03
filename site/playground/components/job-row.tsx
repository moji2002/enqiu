import type { CSSProperties } from "react";
import type { JobSnapshot } from "enqiu";
import {
  formatClock,
  formatRelative,
  progressMessage,
  progressOf,
  shortId,
  statusLabel,
} from "../format";

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
    <li className="job-row-wrap">
      <button
        className="job-row"
        type="button"
        aria-current={selected ? "true" : undefined}
        data-status={job.status}
        onClick={() => onSelect(job.id)}
      >
        <span className="job-ticket" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="job-identity">
          <strong>{job.name}()</strong>
          <small>{shortId(job.id)}</small>
        </span>
        <span className="job-state">
          <span className={`status-mark ${job.status}`} aria-hidden="true" />
          <strong>{statusLabel(job.status)}</strong>
          <small>{message ?? `Attempt ${Math.max(1, job.attempt)}`}</small>
        </span>
        <span className="job-progress" aria-label={`${progress}% complete`}>
          <span><i style={{ "--progress": `${progress}%` } as CSSProperties} /></span>
          <small>{progress}%</small>
        </span>
        <span className="job-meta">
          <time dateTime={new Date(job.createdAt).toISOString()}>
            {formatRelative(job.createdAt)}
          </time>
          {delay || priority ? <small>{delay ?? `${priority} priority`}</small> : null}
        </span>
      </button>
    </li>
  );
}
