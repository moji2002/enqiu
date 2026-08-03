import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
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

const CANCELLABLE = new Set<JobStatus>(["queued", "scheduled", "running"]);
const REDRIVABLE = new Set<JobStatus>(["failed", "cancelled", "expired"]);
const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "expired"]);
const TABS: readonly InspectorTab[] = ["overview", "input", "logs", "result"];

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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tab =
    tabState.jobId === job?.id && tabState.status === job?.status
      ? tabState.tab
      : job?.status === "failed"
        ? "result"
        : "overview";

  const selectTab = (nextTab: InspectorTab) => {
    setTabState({ jobId: job?.id, status: job?.status, tab: nextTab });
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + direction + TABS.length) % TABS.length;
    selectTab(TABS[next]);
    tabRefs.current[next]?.focus();
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
      <aside className="inspector inspector-empty" aria-labelledby="inspector-title">
        <div className="section-heading">
          <div>
            <h2 id="inspector-title">Inspect</h2>
            <p>Evidence from the selected job.</p>
          </div>
          <span className="step-mark">03</span>
        </div>
        <div className="inspector-empty-body">
          <span className="empty-ticket" aria-hidden="true"><i /><i /><i /></span>
          <strong>No job selected</strong>
          <p>Enqueue a job, then inspect its timeline, input, logs, and result.</p>
        </div>
      </aside>
    );
  }

  const progress = progressOf(job);
  const cancellable = CANCELLABLE.has(job.status);
  const redrivable = REDRIVABLE.has(job.status);
  const terminal = TERMINAL.has(job.status);

  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      <div className="inspector-topline">
        {onClose ? <button className="inspector-back" type="button" onClick={onClose}>← Jobs</button> : null}
        <span className={`status-chip ${job.status}`}>
          <i aria-hidden="true" />{statusLabel(job.status)}
        </span>
      </div>
      <div className="inspector-title-row">
        <div>
          <h2 id="inspector-title">{job.name}()</h2>
          <button
            className="copy-id"
            type="button"
            title={idCopyStatus === "idle" ? "Copy full job ID" : idCopyStatus === "copied" ? "Copied" : "Copy unavailable"}
            onClick={() => void copyId()}
          >
            {idCopyStatus === "copied" ? `Copied · ${job.id}` : idCopyStatus === "failed" ? `Copy unavailable · ${job.id}` : job.id}
          </button>
        </div>
        <span className="step-mark">03</span>
      </div>

      <div className="inspector-actions">
        {cancellable ? (
          <button className="danger-action" type="button" onClick={() => actionError(actions.cancelSelected())}>
            Cancel job
          </button>
        ) : null}
        {redrivable ? (
          <button className="primary-action" type="button" onClick={() => actionError(actions.redriveSelected())}>
            Redrive
          </button>
        ) : null}
        {terminal ? (
          <button className={redrivable ? undefined : "primary-action"} type="button" onClick={runAgain}>
            Run again
          </button>
        ) : null}
        {terminal ? <button type="button" onClick={edit}>Edit as new job</button> : null}
      </div>

      <div className="inspector-tabs" role="tablist" aria-label="Job evidence">
        {TABS.map((value, index) => (
          <button
            key={value}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={`tab-${value}`}
            role="tab"
            type="button"
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => selectTab(value)}
            onKeyDown={(event) => handleTabKey(event, index)}
          >
            {tabLabel(value, job)}
            {value === "logs" && (job.logs?.length ?? 0) > 0 ? <span>{job.logs?.length}</span> : null}
          </button>
        ))}
      </div>

      <div
        className="inspector-panel"
        id={`panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        {tab === "overview" ? (
          <>
            <div className="inspector-progress">
              <div><span>Progress</span><strong>{progress}%</strong></div>
              <span><i style={{ "--progress": `${progress}%` } as CSSProperties} /></span>
            </div>
            <dl className="job-facts">
              <div><dt>Attempt</dt><dd>{Math.max(1, job.attempt)} / {job.retries + 1}</dd></div>
              <div><dt>Priority</dt><dd>{job.priority > 0 ? "High" : job.priority < 0 ? "Low" : "Normal"}</dd></div>
              <div><dt>Created</dt><dd>{formatClock(job.createdAt)}</dd></div>
              <div><dt>Duration</dt><dd>{formatDuration(job)}</dd></div>
            </dl>
            <section className="timeline-section">
              <h3>Lifecycle</h3>
              <Lifecycle job={job} />
            </section>
          </>
        ) : null}

        {tab === "input" ? (
          <div className="evidence-stack">
            <CodeBlock label="Job input" value={prettyJson(job.input)} />
            <button className="wide-secondary" type="button" onClick={edit}>Edit as new job</button>
          </div>
        ) : null}

        {tab === "logs" ? (
          (job.logs?.length ?? 0) > 0 ? (
            <ol className="job-logs">
              {job.logs?.map((entry, index) => (
                <li key={`${entry.timestamp}-${entry.message}-${index}`} data-level={entry.level}>
                  <div>
                    <span>{entry.level}</span>
                    <time>{formatClock(entry.timestamp)}</time>
                  </div>
                  <strong>{entry.message}</strong>
                  {entry.fields ? (
                    <details className="log-fields">
                      <summary>Structured fields</summary>
                      <pre>{prettyJson(entry.fields)}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <div className="evidence-empty">
              <strong>No handler logs yet</strong>
              <p>Structured logs appear here as the selected handler runs.</p>
            </div>
          )
        ) : null}

        {tab === "result" ? (
          job.status === "failed" ? (
            <div className="error-evidence">
              <div>
                <span>{job.error?.name ?? "Error"}</span>
                <strong>{job.error?.message ?? "The handler failed."}</strong>
              </div>
              {job.error?.stack ? <CodeBlock label="Stack" value={job.error.stack} /> : null}
              <button className="primary-action wide-secondary" type="button" onClick={() => actionError(actions.redriveSelected())}>
                Redrive this job
              </button>
            </div>
          ) : job.output !== undefined ? (
            <CodeBlock label="Typed result" value={prettyJson(job.output)} />
          ) : (
            <div className="evidence-empty">
              <strong>Result not available yet</strong>
              <p>The handler output appears here when this job succeeds.</p>
            </div>
          )
        ) : null}
      </div>
    </aside>
  );
}
