import { useMemo, useState } from "react";
import type { JobSnapshot, JobStatus } from "enqiu";
import type {
  PlaygroundActions,
  PlaygroundState,
  QueueFilter,
} from "../types";
import { NumberTicker } from "./beui/number-ticker";
import { BeUiButton } from "./beui/button";
import { JobRow } from "./job-row";
import { BeUiInput } from "./beui/input";
import { cn } from "../lib/utils";
import { EmptyState, Panel, PanelHeader } from "./ui/layout";

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
  return <i className={cn("h-1.5 flex-1 rounded-full", active ? "bg-blue-500" : "bg-neutral-700")} aria-hidden="true" />;
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
    <Panel className="h-full overflow-hidden" aria-labelledby="queue-title">
      <PanelHeader number="02" title="Live queue" description={state.stats.total === 0 ? "Ready for the first job." : `${state.stats.total} jobs running in this browser tab.`} />

      {state.paused ? (
        <div className="m-4 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status">
          <strong className="font-medium">Worker paused</strong>
          <span className="text-xs opacity-75">Queued jobs wait; running jobs finish.</span>
        </div>
      ) : state.stats.running === state.concurrency && state.stats.queued > 0 ? (
        <div className="m-4 flex items-center justify-between gap-3 rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200" role="status">
          <strong className="font-medium">Concurrency full</strong>
          <span className="text-xs opacity-75">Waiting for a worker slot.</span>
        </div>
      ) : null}

      <div className="m-4 grid grid-cols-[1fr_1.3fr_1fr] overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950 text-white" aria-label={`${waiting} waiting, ${state.stats.running} running, ${terminal} stopped`}>
        <div className="flex min-w-0 flex-col justify-between p-3 sm:p-4">
          <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">Waiting</span>
          <strong className="mt-3 text-2xl font-semibold tabular-nums"><NumberTicker value={waiting} /></strong>
          <div className="mt-4 flex gap-1" aria-hidden="true">
            {Array.from({ length: 3 }, (_, index) => (
              <i className={cn("h-1.5 flex-1 rounded-full", index < waiting ? "bg-amber-400" : "bg-neutral-800")} key={index} />
            ))}
          </div>
        </div>
        <div className="border-x border-neutral-800 bg-neutral-900/70 p-3 sm:p-4">
          <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">{state.paused ? "Gate closed" : "Worker slots"}</span>
          <div className="mt-4 flex gap-1.5">
            {[0, 1, 2, 3].slice(0, state.concurrency).map((slot) => (
              <GateSlot key={slot} active={slot < state.stats.running} />
            ))}
          </div>
          <strong className="mt-3 block font-mono text-sm font-medium"><NumberTicker value={state.stats.running} /> / {state.concurrency} active</strong>
        </div>
        <div className="flex min-w-0 flex-col justify-between p-3 sm:p-4">
          <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">History</span>
          <strong className="mt-3 text-2xl font-semibold tabular-nums"><NumberTicker value={terminal} /></strong>
          <div className="mt-4 flex gap-1" aria-hidden="true"><i className="h-1.5 flex-1 rounded-full bg-emerald-500" /><i className="h-1.5 flex-1 rounded-full bg-red-500" /><i className="h-1.5 flex-1 rounded-full bg-neutral-700" /></div>
        </div>
      </div>

      <div className="mx-4 grid grid-cols-4 divide-x divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800" aria-label="Queue statistics" aria-live="polite">
        {([
          ["Queued", state.stats.queued, "bg-amber-400"],
          ["Running", state.stats.running, "bg-blue-500"],
          ["Succeeded", state.stats.succeeded, "bg-emerald-500"],
          ["Failed", state.stats.failed, "bg-red-500"],
        ] as const).map(([label, value, tone]) => (
          <span className="flex min-w-0 flex-col gap-1 px-2 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-3" key={label}>
            <span className="flex items-center gap-1.5 truncate text-[11px] text-neutral-500"><i className={cn("size-1.5 shrink-0 rounded-full", tone)} />{label}</span>
            <strong className="font-mono text-xs"><NumberTicker value={value} /></strong>
          </span>
        ))}
      </div>

      <div className="mt-4 grid gap-2 border-y border-neutral-200 bg-neutral-50 p-3 lg:grid-cols-[1fr_180px] dark:border-neutral-800 dark:bg-neutral-900/40">
        <div className="flex min-w-0 gap-1 overflow-x-auto" aria-label="Filter jobs">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
              className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-white hover:text-black focus-visible:outline-2 focus-visible:outline-blue-500 aria-pressed:bg-black aria-pressed:text-white dark:hover:bg-neutral-800 dark:hover:text-white dark:aria-pressed:bg-white dark:aria-pressed:text-black"
            >
              <span>{option.label}</span>
              <strong className="font-mono text-[10px] opacity-70">{filterCount(option.value, state)}</strong>
            </button>
          ))}
        </div>
        <div>
          <BeUiInput
            aria-label="Search jobs"
            type="search"
            name="job-search"
            value={search}
            autoComplete="off"
            placeholder="Search jobs…"
            onValueChange={setSearch}
            className="[&_div]:min-h-9 [&_input]:min-h-9"
          />
        </div>
      </div>

      <div className="flex min-h-10 items-center justify-between border-b border-neutral-200 px-4 font-mono text-[10px] uppercase tracking-wider text-neutral-500 dark:border-neutral-800">
        <span>{visibleJobs.length} shown</span>
        {filtered ? (
          <button className="rounded px-2 py-1 normal-case tracking-normal text-neutral-600 hover:bg-neutral-100 hover:text-black focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-900 dark:hover:text-white"
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
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
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
        <EmptyState
          title={filtered ? "No jobs match this view" : "Queue is ready"}
          description={filtered ? "Clear the filter or search another job name." : "Enqueue a handler and watch the real lifecycle appear here."}
          action={filtered ? (
            <BeUiButton
              type="button"
              onClick={() => {
                setFilter("all");
                setSearch("");
              }}
            >
              Clear filter
            </BeUiButton>
          ) : undefined}
        />
      )}
    </Panel>
  );
}
