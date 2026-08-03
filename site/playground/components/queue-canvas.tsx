import { useMemo, useState } from "react";
import type { JobSnapshot, JobStatus } from "enqiu";
import type {
  PlaygroundActions,
  PlaygroundState,
  QueueFilter,
} from "../types";
import { JobRow } from "./job-row";

const ACTIVE = new Set<JobStatus>(["queued", "scheduled", "running"]);
const STOPPED = new Set<JobStatus>(["cancelled", "expired"]);

const FILTERS: readonly { value: QueueFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "scheduled", label: "Scheduled" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
];

function matchesFilter(job: JobSnapshot, filter: QueueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE.has(job.status);
  if (filter === "stopped") return STOPPED.has(job.status);
  return job.status === filter;
}

function filterCount(filter: QueueFilter, state: PlaygroundState): number {
  if (filter === "all") return state.stats.total;
  if (filter === "active") {
    return state.stats.queued + state.stats.scheduled + state.stats.running;
  }
  if (filter === "stopped") return state.stats.cancelled + state.stats.expired;
  return state.stats[filter];
}

function GateSlot({ active }: { active: boolean }) {
  return <i data-active={active} aria-hidden="true" />;
}

export function QueueCanvas({
  state,
  actions,
}: {
  state: PlaygroundState;
  actions: PlaygroundActions;
}) {
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [search, setSearch] = useState("");
  const visibleJobs = useMemo(() => {
    const query = search.trim().toLowerCase();
    return state.jobs.filter(
      (job) =>
        matchesFilter(job, filter) &&
        (!query || job.name.toLowerCase().includes(query) || job.id.toLowerCase().includes(query)),
    );
  }, [filter, search, state.jobs]);
  const filtered = filter !== "all" || search.trim().length > 0;
  const waiting = state.stats.queued + state.stats.scheduled;
  const terminal =
    state.stats.succeeded +
    state.stats.failed +
    state.stats.cancelled +
    state.stats.expired;

  return (
    <section className="queue-canvas" aria-labelledby="queue-title">
      <div className="section-heading queue-heading">
        <div>
          <h2 id="queue-title">Live queue</h2>
          <p>{state.stats.total === 0 ? "Nothing queued yet." : `${state.stats.total} real jobs in this tab.`}</p>
        </div>
        <span className="step-mark">02</span>
      </div>

      {state.paused ? (
        <div className="queue-notice paused-notice" role="status">
          <strong>Paused</strong>
          <span>Queued jobs will wait; running jobs will finish.</span>
        </div>
      ) : state.stats.running === state.concurrency && state.stats.queued > 0 ? (
        <div className="queue-notice limit-notice" role="status">
          <strong>Worker limit full</strong>
          <span>Extra jobs stay queued until a slot opens.</span>
        </div>
      ) : null}

      <div className="queue-gate" aria-label={`${waiting} waiting, ${state.stats.running} running, ${terminal} stopped`}>
        <div className="gate-stage waiting-stage">
          <span>Waiting</span>
          <strong>{waiting}</strong>
          <div aria-hidden="true">
            {Array.from({ length: Math.min(3, waiting) }, (_, index) => (
              <i key={index} />
            ))}
          </div>
        </div>
        <div className="gate-worker" data-paused={state.paused}>
          <span>{state.paused ? "Gate closed" : "Worker gate"}</span>
          <div>
            {[0, 1, 2, 3].slice(0, state.concurrency).map((slot) => (
              <GateSlot key={slot} active={slot < state.stats.running} />
            ))}
          </div>
          <strong>{state.stats.running} / {state.concurrency}</strong>
        </div>
        <div className="gate-stage terminal-stage">
          <span>History</span>
          <strong>{terminal}</strong>
          <div aria-hidden="true"><i /><i /><i /></div>
        </div>
      </div>

      <div className="queue-summary" aria-label="Queue statistics" aria-live="polite">
        <span><i className="queued" />Queued <strong>{state.stats.queued}</strong></span>
        <span><i className="running" />Running <strong>{state.stats.running}</strong></span>
        <span><i className="succeeded" />Succeeded <strong>{state.stats.succeeded}</strong></span>
        <span><i className="failed" />Failed <strong>{state.stats.failed}</strong></span>
      </div>

      <div className="queue-filters">
        <div className="filter-scroll" aria-label="Filter jobs">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              <span>{option.label}</span>
              <strong>{filterCount(option.value, state)}</strong>
            </button>
          ))}
        </div>
        <label className="job-search">
          <span className="sr-only">Search jobs</span>
          <input
            type="search"
            value={search}
            placeholder="Search jobs"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      <div className="result-count">
        <span>{visibleJobs.length} shown</span>
        {filtered ? (
          <button
            type="button"
            onClick={() => {
              setFilter("all");
              setSearch("");
            }}
          >
            Clear filter
          </button>
        ) : null}
      </div>

      {visibleJobs.length > 0 ? (
        <ul className="live-job-list">
          {visibleJobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              selected={job.id === state.selectedId}
              onSelect={actions.select}
            />
          ))}
        </ul>
      ) : (
        <div className="queue-empty">
          <span className="empty-ticket" aria-hidden="true"><i /><i /><i /></span>
          <strong>{filtered ? "No jobs match this view" : "Enqueue the example"}</strong>
          <p>
            {filtered
              ? "Clear the filter or try another job name."
              : "The real queue is ready. Your first job will appear here."}
          </p>
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setSearch("");
              }}
            >
              Clear filter
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
