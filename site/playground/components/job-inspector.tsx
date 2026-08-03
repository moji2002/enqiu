import {
  useState,
} from "react";
import type { JobSnapshot, JobStatus } from "enqiu";
import {
  formatClock,
  formatDuration,
  prettyJson,
  progressOf,
  statusLabel,
} from "../format";
import type {
  ComposerDraft,
  InspectorTab,
  PlaygroundActions,
} from "../types";
import { CodeBlock } from "./code-block";
import { Lifecycle } from "./lifecycle";
import { BeUiButton } from "./beui/button";
import { BeUiTabs, BeUiTabsList, BeUiTabsTrigger } from "./beui/motion-tabs";
import { EmptyState, Panel, PanelHeader } from "./ui/layout";
import { cn } from "../lib/utils";

const CANCELLABLE = new Set<JobStatus>(["queued", "scheduled", "running"]);
const REDRIVABLE = new Set<JobStatus>(["failed", "cancelled", "expired"]);
const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "expired"]);
const TABS: readonly InspectorTab[] = ["overview", "input", "logs", "result"];
const statusTone: Record<JobStatus, string> = {
  queued: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  scheduled: "border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300",
  running: "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  succeeded: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  failed: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  cancelled: "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300",
  expired: "border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900 dark:bg-orange-950/40 dark:text-orange-300",
};

function tabLabel(tab: InspectorTab, job: JobSnapshot): string {
  if (tab === "result" && job.status === "failed") return "Error";
  return tab.charAt(0).toUpperCase() + tab.slice(1);
}

function actionError(action: Promise<void>): void {
  void action.catch(() => undefined);
}

export function JobInspector({
  job,
  actions,
  onEditDraft,
  onClose,
}: {
  job: JobSnapshot | undefined;
  actions: PlaygroundActions;
  onEditDraft: (draft: ComposerDraft) => void;
  onClose?: () => void;
}) {
  const [tabState, setTabState] = useState<{
    jobId: string | undefined;
    status: JobStatus | undefined;
    tab: InspectorTab;
  }>({ jobId: undefined, status: undefined, tab: "overview" });
  const [idCopyStatus, setIdCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const tab =
    tabState.jobId === job?.id && tabState.status === job?.status
      ? tabState.tab
      : job?.status === "failed"
        ? "result"
        : "overview";

  const selectTab = (nextTab: InspectorTab) => {
    setTabState({ jobId: job?.id, status: job?.status, tab: nextTab });
  };

  const edit = () => {
    const draft = actions.draftFromSelected();
    if (draft) onEditDraft(draft);
  };

  const runAgain = () => {
    const draft = actions.draftFromSelected();
    if (draft) actionError(actions.enqueue(draft));
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(job?.id ?? "");
      setIdCopyStatus("copied");
    } catch {
      setIdCopyStatus("failed");
    }
    window.setTimeout(() => setIdCopyStatus("idle"), 1_400);
  };

  if (!job) {
    return (
      <Panel className="h-full overflow-hidden" aria-labelledby="inspector-title">
        <PanelHeader number="03" title="Inspect" description="Lifecycle evidence from the selected job." />
        <EmptyState title="No job selected" description="Enqueue a job, then inspect its timeline, input, logs, and typed result." />
      </Panel>
    );
  }

  const progress = progressOf(job);
  const cancellable = CANCELLABLE.has(job.status);
  const redrivable = REDRIVABLE.has(job.status);
  const terminal = TERMINAL.has(job.status);

  return (
    <Panel className="h-full overflow-hidden" aria-labelledby="inspector-title">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        {onClose ? <BeUiButton className="md:hidden" size="sm" variant="ghost" type="button" onClick={onClose}>← Jobs</BeUiButton> : <span />}
        <span className={cn("inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium", statusTone[job.status])}>
          <i className="size-1.5 rounded-full bg-current" aria-hidden="true" />{statusLabel(job.status)}
        </span>
      </div>
      <div className="flex items-start justify-between gap-4 px-4 py-4">
        <div className="min-w-0">
          <h2 className="font-mono text-base font-semibold" id="inspector-title">{job.name}()</h2>
          <button
            className="mt-1 block max-w-full truncate rounded font-mono text-[10px] text-neutral-500 hover:text-black focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:text-white"
            type="button"
            title={idCopyStatus === "idle" ? "Copy full job ID" : idCopyStatus === "copied" ? "Copied" : "Copy unavailable"}
            onClick={() => void copyId()}
          >
            {idCopyStatus === "copied" ? `Copied · ${job.id}` : idCopyStatus === "failed" ? `Copy unavailable · ${job.id}` : job.id}
          </button>
        </div>
        <span className="font-mono text-xs text-neutral-400">03</span>
      </div>

      <div className="flex flex-wrap gap-2 px-4 pb-4">
        {cancellable ? (
          <BeUiButton variant="danger" size="sm" type="button" onClick={() => actionError(actions.cancelSelected())}>
            Cancel job
          </BeUiButton>
        ) : null}
        {redrivable ? (
          <BeUiButton variant="primary" size="sm" type="button" onClick={() => actionError(actions.redriveSelected())}>
            Redrive
          </BeUiButton>
        ) : null}
        {terminal ? (
          <BeUiButton variant={redrivable ? "secondary" : "primary"} size="sm" type="button" onClick={runAgain}>
            Run again
          </BeUiButton>
        ) : null}
        {terminal ? <BeUiButton size="sm" type="button" onClick={edit}>Edit as new job</BeUiButton> : null}
      </div>

      <BeUiTabs value={tab} onValueChange={(value) => selectTab(value as InspectorTab)} className="border-y border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <BeUiTabsList className="flex rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900" ariaLabel="Job evidence">
        {TABS.map((value) => (
          <BeUiTabsTrigger
            key={value}
            value={value}
            className="min-h-9 px-1 text-xs"
          >
            {tabLabel(value, job)}
            {value === "logs" && (job.logs?.length ?? 0) > 0 ? <span className="ml-1 font-mono text-[9px] opacity-70">{job.logs?.length}</span> : null}
          </BeUiTabsTrigger>
        ))}
        </BeUiTabsList>
      </BeUiTabs>

      <div
        className="p-4"
        id={`panel-${tab}`}
        role="tabpanel"
        aria-label={`${tabLabel(tab, job)} evidence`}
      >
        {tab === "overview" ? (
          <>
            <div>
              <div className="flex items-center justify-between text-xs"><span className="text-neutral-500">Progress</span><strong className="font-mono">{progress}%</strong></div>
              <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"><i className="block h-full rounded-full bg-blue-500 transition-[width] duration-300" style={{ width: `${progress}%` }} /></span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200 dark:border-neutral-800 dark:bg-neutral-800">
              <div className="bg-white p-3 dark:bg-neutral-950"><dt className="text-[10px] text-neutral-500">Attempt</dt><dd className="mt-1 font-mono text-xs">{Math.max(1, job.attempt)} / {job.retries + 1}</dd></div>
              <div className="bg-white p-3 dark:bg-neutral-950"><dt className="text-[10px] text-neutral-500">Priority</dt><dd className="mt-1 font-mono text-xs">{job.priority > 0 ? "High" : job.priority < 0 ? "Low" : "Normal"}</dd></div>
              <div className="bg-white p-3 dark:bg-neutral-950"><dt className="text-[10px] text-neutral-500">Created</dt><dd className="mt-1 font-mono text-xs">{formatClock(job.createdAt)}</dd></div>
              <div className="bg-white p-3 dark:bg-neutral-950"><dt className="text-[10px] text-neutral-500">Duration</dt><dd className="mt-1 font-mono text-xs">{formatDuration(job)}</dd></div>
            </dl>
            <section className="mt-5">
              <h3 className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">Lifecycle</h3>
              <Lifecycle job={job} />
            </section>
          </>
        ) : null}

        {tab === "input" ? (
          <div className="space-y-3">
            <CodeBlock label="Job input" value={prettyJson(job.input)} />
            <BeUiButton className="w-full" type="button" onClick={edit}>Edit as new job</BeUiButton>
          </div>
        ) : null}

        {tab === "logs" ? (
          (job.logs?.length ?? 0) > 0 ? (
            <ol className="space-y-2">
              {job.logs?.map((entry, index) => (
                <li className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800" key={`${entry.timestamp}-${entry.message}-${index}`} data-level={entry.level}>
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase text-neutral-500">
                    <span>{entry.level}</span>
                    <time>{formatClock(entry.timestamp)}</time>
                  </div>
                  <strong className="mt-2 block text-xs font-medium">{entry.message}</strong>
                  {entry.fields ? (
                    <details className="mt-2">
                      <summary className="text-xs text-neutral-500">Structured fields</summary>
                      <pre className="mt-2 overflow-auto rounded bg-neutral-950 p-3 font-mono text-[10px] text-neutral-300">{prettyJson(entry.fields)}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No handler logs yet" description="Structured logs appear here as the selected handler runs." />
          )
        ) : null}

        {tab === "result" ? (
          job.status === "failed" ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
                <span className="font-mono text-[10px] uppercase text-red-600">{job.error?.name ?? "Error"}</span>
                <strong className="mt-1 block text-sm text-red-900 dark:text-red-200">{job.error?.message ?? "The handler failed."}</strong>
              </div>
              {job.error?.stack ? <CodeBlock label="Stack" value={job.error.stack} /> : null}
              <BeUiButton className="w-full" variant="primary" type="button" onClick={() => actionError(actions.redriveSelected())}>
                Redrive this job
              </BeUiButton>
            </div>
          ) : job.output !== undefined ? (
            <CodeBlock label="Typed result" value={prettyJson(job.output)} />
          ) : (
            <EmptyState title="Result not available yet" description="The typed handler output appears here when this job succeeds." />
          )
        ) : null}
      </div>
    </Panel>
  );
}
