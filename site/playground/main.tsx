import { Component, useCallback, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { JobSnapshot } from "enqiu";
import { BeUiButton } from "./components/beui/button";
import { NumberTicker } from "./components/beui/number-ticker";
import { JobComposer } from "./components/job-composer";
import { JobInspector } from "./components/job-inspector";
import { QueueToolbar } from "./components/queue-toolbar";
import { SpatialQueue, type SpatialToken } from "./components/spatial-queue";
import { formatRelative, shortId, statusLabel } from "./format";
import { cn } from "./lib/utils";
import { defaultDraft } from "./queue";
import type { ComposerDraft, PlaygroundActions } from "./types";
import { usePlaygroundQueue } from "./use-playground-queue";
import "../tailwind.css";

class PlaygroundBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Enqiu playground failed", error, info.componentStack); }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="grid min-h-screen place-items-center bg-[#f5f5f2] p-6 font-sans text-neutral-950">
        <section className="max-w-md rounded-3xl border border-neutral-200 bg-white p-8 text-center shadow-xl">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-red-50 font-mono text-red-600">!</span>
          <h1 className="mt-5 text-xl font-semibold tracking-tight">The browser queue stopped</h1>
          <p className="mt-2 text-sm leading-6 text-neutral-500">Reload the playground. Your composer draft remains in this tab.</p>
          <BeUiButton className="mt-6 rounded-full" variant="primary" type="button" onClick={() => window.location.reload()}>Reload playground</BeUiButton>
        </section>
      </main>
    );
  }
}

const statusDot: Record<JobSnapshot["status"], string> = {
  queued: "bg-amber-400", scheduled: "bg-violet-500", running: "bg-sky-500",
  succeeded: "bg-emerald-500", failed: "bg-rose-500", cancelled: "bg-neutral-400", expired: "bg-orange-500",
};

function FlightRecorder({ jobs, selectedId, onSelect }: { jobs: readonly JobSnapshot[]; selectedId?: string; onSelect(id: string): void }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="recorder-title">
      <div className="flex items-end justify-between border-b border-neutral-200 px-4 pb-3">
        <div><p className="font-mono text-[9px] uppercase tracking-[0.18em] text-neutral-400">Flight recorder</p><h2 className="mt-1 text-sm font-semibold" id="recorder-title">Job history</h2></div>
        <span className="font-mono text-[10px] text-neutral-400">{jobs.length} total</span>
      </div>
      {jobs.length ? (
        <ol className="min-h-0 flex-1 overflow-y-auto p-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <button
                className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-violet-500 aria-current:bg-violet-50"
                type="button"
                aria-current={selectedId === job.id ? "true" : undefined}
                onClick={() => onSelect(job.id)}
              >
                <i className={cn("size-2 rounded-full shadow-[0_0_0_4px_rgb(0_0_0/0.04)]", statusDot[job.status])} />
                <span className="min-w-0"><strong className="block truncate font-mono text-[11px] font-medium">{job.name}()</strong><small className="mt-1 block truncate font-mono text-[9px] text-neutral-400">{shortId(job.id)}</small></span>
                <span className="text-right"><strong className="block text-[10px] font-medium">{statusLabel(job.status)}</strong><time className="mt-1 block font-mono text-[9px] text-neutral-400">{formatRelative(job.createdAt)}</time></span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="grid flex-1 place-items-center px-6 text-center"><div><span className="mx-auto block size-2 rounded-full bg-neutral-300" /><strong className="mt-4 block text-sm">No jobs in flight</strong><p className="mt-1 text-xs leading-5 text-neutral-400">Launch a handler and its path appears here.</p></div></div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div className="min-w-0"><span className="flex items-center gap-1.5 truncate text-[9px] uppercase tracking-wider text-neutral-400"><i className={cn("size-1.5 rounded-full", tone)} />{label}</span><strong className="mt-1 block text-xl font-semibold tabular-nums"><NumberTicker value={value} /></strong></div>;
}

type SidePanel = "compose" | "inspect" | null;

function PlaygroundApp() {
  const [state, actions] = usePlaygroundQueue();
  const [draft, setDraft] = useState<ComposerDraft>(defaultDraft);
  const [panel, setPanel] = useState<SidePanel>(null);
  const reduceMotion = useReducedMotion();
  const selectedJob = state.jobs.find((job) => job.id === state.selectedId);

  const tokens = useMemo<SpatialToken[]>(() => state.jobs.slice(0, 8).map((job) => ({ id: job.id, label: `${job.name}()`, status: job.status })), [state.jobs]);

  const select = useCallback((id: string) => {
    actions.select(id);
    setPanel("inspect");
  }, [actions]);

  const workbenchActions = useMemo<PlaygroundActions>(() => ({ ...actions, select }), [actions, select]);

  const enqueue = async (nextDraft: ComposerDraft) => {
    await actions.enqueue(nextDraft);
    setPanel(null);
  };

  const enqueueScenario = async (kind: "queue-three" | "fail-once" | "schedule-five", nextDraft: ComposerDraft) => {
    await actions.enqueueScenario(kind, nextDraft);
    setPanel(null);
  };

  const editDraft = (nextDraft: ComposerDraft) => {
    setDraft(nextDraft);
    setPanel("compose");
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f5f5f2] font-sans text-neutral-950 antialiased selection:bg-violet-200">
      <a className="fixed left-3 top-3 z-[100] -translate-y-24 rounded-full bg-black px-4 py-2 text-sm text-white transition-transform focus:translate-y-0" href="#queue-field">Skip to queue</a>
      <header className="relative z-50 flex min-h-[72px] items-center gap-3 border-b border-neutral-200 bg-[#f5f5f2]/90 px-4 backdrop-blur-xl sm:px-6">
        <a href="/" className="text-xl font-semibold tracking-[-0.055em]" aria-label="Enqiu home">enqiu<span className="text-violet-600">/</span></a>
        <span className="h-5 w-px bg-neutral-200" />
        <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-medium">Queue field</h1><p className="truncate font-mono text-[9px] uppercase tracking-wider text-neutral-400">Real browser memory driver</p></div>
        <QueueToolbar state={state} actions={actions} />
        <BeUiButton className="hidden rounded-full border-neutral-950 bg-neutral-950 text-white hover:bg-neutral-800 sm:inline-flex dark:border-neutral-950 dark:bg-neutral-950 dark:text-white" variant="primary" type="button" onClick={() => setPanel(panel === "compose" ? null : "compose")}>+ New job</BeUiButton>
      </header>

      {state.alert ? (
        <div className="fixed left-1/2 top-20 z-[70] flex w-[min(92vw,460px)] -translate-x-1/2 items-center justify-between rounded-full bg-neutral-950 px-4 py-3 text-xs text-white shadow-2xl" role="status"><span className="truncate font-mono">{state.alert}</span><button className="ml-3 grid size-6 place-items-center rounded-full hover:bg-white/10" type="button" aria-label="Dismiss" onClick={actions.clearAlert}>×</button></div>
      ) : null}

      <main className="relative mx-auto grid min-h-[calc(100vh-72px)] max-w-[1600px] gap-3 p-3 lg:grid-cols-[280px_minmax(0,1fr)]" id="queue-field">
        <aside className="order-2 flex min-h-[420px] flex-col overflow-hidden rounded-[24px] border border-neutral-200 bg-white py-4 lg:order-1 lg:h-[calc(100vh-96px)]">
          <div className="grid grid-cols-3 gap-3 px-4 pb-5">
            <Stat label="Waiting" value={state.stats.queued + state.stats.scheduled} tone="bg-amber-400" />
            <Stat label="Running" value={state.stats.running} tone="bg-sky-500" />
            <Stat label="Done" value={state.stats.succeeded} tone="bg-emerald-500" />
          </div>
          <FlightRecorder jobs={state.jobs} selectedId={state.selectedId} onSelect={select} />
        </aside>

        <section className="relative order-1 min-h-[620px] lg:order-2 lg:h-[calc(100vh-96px)]" aria-labelledby="field-title">
          <h2 className="sr-only" id="field-title">Live spatial queue</h2>
          <SpatialQueue
            className="h-full min-h-[620px]"
            tokens={tokens}
            queued={state.stats.queued + state.stats.scheduled}
            running={state.stats.running}
            concurrency={state.concurrency}
            paused={state.paused}
            onSelect={select}
          />

          <div className="absolute inset-x-3 bottom-3 z-40 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/60 p-2 text-white shadow-2xl backdrop-blur-xl sm:inset-x-auto sm:left-4 sm:bottom-4">
            <BeUiButton className="flex-1 rounded-full border-white bg-white text-black hover:bg-neutral-200 sm:flex-none dark:border-white dark:bg-white dark:text-black" variant="primary" type="button" onClick={() => setPanel("compose")}>Launch a job</BeUiButton>
            <button className="min-h-10 rounded-full px-3 font-mono text-[10px] text-white/55 transition-colors hover:bg-white/10 hover:text-white" type="button" onClick={() => void actions.enqueueScenario("queue-three", draft).catch(() => undefined)}>Queue three</button>
            <button className="hidden min-h-10 rounded-full px-3 font-mono text-[10px] text-white/55 transition-colors hover:bg-white/10 hover:text-white sm:block" type="button" onClick={() => void actions.enqueueScenario("fail-once", draft).catch(() => undefined)}>Retry scenario</button>
          </div>
        </section>
      </main>

      <AnimatePresence>
        {panel ? (
          <>
            <motion.button className="fixed inset-0 z-[74] bg-black/35 backdrop-blur-[2px]" aria-label="Close side panel" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPanel(null)} />
            <motion.aside
              className="fixed inset-y-0 right-0 z-[75] w-full max-w-[430px] overflow-y-auto border-l border-neutral-200 bg-[#f5f5f2] p-3 shadow-2xl"
              role="dialog"
              aria-modal="true"
              aria-label={panel === "compose" ? "Compose a job" : "Inspect selected job"}
              initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <button className="sticky top-2 z-10 ml-auto mb-2 grid size-10 place-items-center rounded-full border border-neutral-200 bg-white text-lg shadow-sm hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-violet-500" type="button" aria-label="Close panel" onClick={() => setPanel(null)}>×</button>
              {panel === "compose" ? (
                <JobComposer draft={draft} onDraftChange={setDraft} onEnqueue={enqueue} onScenario={enqueueScenario} busyAction={state.busyAction} />
              ) : (
                <JobInspector job={selectedJob} actions={workbenchActions} onEditDraft={editDraft} onClose={() => setPanel(null)} />
              )}
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{state.stats.running} running, {state.stats.queued} queued, {state.stats.failed} failed.</div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Playground root element is missing");
createRoot(root).render(<PlaygroundBoundary><PlaygroundApp /></PlaygroundBoundary>);
