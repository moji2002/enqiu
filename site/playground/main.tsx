import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { JobComposer } from "./components/job-composer";
import { JobInspector } from "./components/job-inspector";
import { QueueCanvas } from "./components/queue-canvas";
import { QueueToolbar } from "./components/queue-toolbar";
import { defaultDraft } from "./queue";
import type {
  ComposerDraft,
  MobileView,
  PlaygroundActions,
} from "./types";
import { usePlaygroundQueue } from "./use-playground-queue";
import "./playground.css";

class PlaygroundBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Enqiu playground failed", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crash-state">
        <span className="crash-mark" aria-hidden="true"><i /><i /><i /></span>
        <h1>The browser queue stopped</h1>
        <p>Your JSON draft is still saved in this tab. Reload it, or clear the draft and start fresh.</p>
        <div>
          <button type="button" onClick={() => window.location.reload()}>Reload playground</button>
          <button
            type="button"
            onClick={() => {
              window.sessionStorage.removeItem("enqiu.playground.composer.v1");
              window.location.reload();
            }}
          >
            Reset draft
          </button>
        </div>
      </main>
    );
  }
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

function PlaygroundApp() {
  const [state, actions] = usePlaygroundQueue();
  const [draft, setDraft] = useState<ComposerDraft>(defaultDraft);
  const [mobileView, setMobileView] = useState<MobileView>("compose");
  const selectedJob = state.jobs.find((job) => job.id === state.selectedId);

  useEffect(() => {
    if (window.matchMedia("(max-width: 699px)").matches) {
      window.scrollTo({ top: 0 });
    }
  }, [mobileView]);

  const workbenchActions = useMemo<PlaygroundActions>(
    () => ({
      ...actions,
      select(id: string) {
        actions.select(id);
        setMobileView("inspect");
      },
    }),
    [actions],
  );

  const editDraft = (nextDraft: ComposerDraft) => {
    setDraft(nextDraft);
    setMobileView("compose");
  };

  return (
    <div className="playground-shell" data-mobile-view={mobileView}>
      <a className="skip-link" href="#workbench">Skip to workbench</a>
      <header className="playground-header">
        <div className="playground-branding">
          <a href="/" className="wordmark" aria-label="Back to Enqiu home">
            enqiu<span>.</span>
          </a>
          <span className="brand-divider" aria-hidden="true" />
          <div>
            <h1>Playground</h1>
            <span><BrandMark /> Real Enqiu · Memory</span>
          </div>
        </div>
        <nav aria-label="Playground navigation">
          <a href="/#quick-start">Docs</a>
          <a href="https://github.com/moji2002/enqiu">GitHub ↗</a>
        </nav>
        <QueueToolbar state={state} actions={actions} />
      </header>

      {state.alert ? (
        <div className="global-alert" role="status">
          <span>{state.alert}</span>
          <button type="button" aria-label="Dismiss message" onClick={actions.clearAlert}>×</button>
        </div>
      ) : null}

      <nav className="mobile-task-nav" aria-label="Playground view">
        {(["compose", "jobs", "inspect"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={mobileView === view}
            disabled={view === "inspect" && !selectedJob}
            onClick={() => setMobileView(view)}
          >
            {view === "jobs" ? `Jobs ${state.stats.total}` : view.charAt(0).toUpperCase() + view.slice(1)}
          </button>
        ))}
      </nav>

      <main className="workbench-grid" id="workbench">
        <JobComposer
          draft={draft}
          onDraftChange={setDraft}
          onEnqueue={actions.enqueue}
          onScenario={actions.enqueueScenario}
          busyAction={state.busyAction}
        />
        <QueueCanvas state={state} actions={workbenchActions} />
        <JobInspector
          job={selectedJob}
          actions={actions}
          onEditDraft={editDraft}
          onClose={() => setMobileView("jobs")}
        />
      </main>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {state.stats.running} running, {state.stats.queued} queued, {state.stats.failed} failed.
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Playground root element is missing");
createRoot(root).render(
  <PlaygroundBoundary>
    <PlaygroundApp />
  </PlaygroundBoundary>,
);
