import { useState } from "react";
import type { PlaygroundActions, PlaygroundState } from "../types";
import { BeUiButton } from "./beui/button";
import { BeUiMorphingModal } from "./beui/morphing-modal";
import { cn } from "../lib/utils";

export function QueueToolbar({
  state,
  actions,
}: {
  state: PlaygroundState;
  actions: PlaygroundActions;
}) {
  const [confirmReset, setConfirmReset] = useState(false);
  const runningLabel = `${state.stats.running} / ${state.concurrency}`;

  return (
    <div className="flex items-center gap-2" aria-label="Worker controls">
      <div className="hidden min-w-36 items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 lg:flex dark:border-neutral-800">
        <span className={cn("size-2 rounded-full", state.paused ? "bg-amber-500" : "bg-emerald-500")} />
        <span className="min-w-0 leading-none">
          <strong className="block text-xs font-medium">{state.paused ? "Worker paused" : "Worker running"}</strong>
          <small className="mt-1 block font-mono text-[10px] text-neutral-500">{runningLabel} slots occupied</small>
        </span>
      </div>

      <BeUiButton
        className="min-h-9 px-3"
        type="button"
        disabled={state.busyAction === "pause" || state.busyAction === "resume"}
        onClick={() => void actions.setPaused(!state.paused).catch(() => undefined)}
      >
        {state.paused ? "Resume" : "Pause"}
      </BeUiButton>

      <div className="hidden items-center rounded-md border border-neutral-200 p-0.5 lg:flex dark:border-neutral-800" aria-label="Worker concurrency">
        {[1, 2, 4].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={state.concurrency === value}
            disabled={state.busyAction === "concurrency"}
            className="grid size-8 place-items-center rounded text-xs font-medium text-neutral-500 transition-colors hover:text-black focus-visible:outline-2 focus-visible:outline-blue-500 aria-pressed:bg-black aria-pressed:text-white disabled:opacity-50 dark:hover:text-white dark:aria-pressed:bg-white dark:aria-pressed:text-black"
            onClick={() =>
              void actions
                .setConcurrency(value as 1 | 2 | 4)
                .catch(() => undefined)
            }
          >
            {value}
          </button>
        ))}
      </div>

      <label className="lg:hidden">
        <span className="sr-only">Worker concurrency</span>
        <select
          name="worker-concurrency"
          aria-label="Worker concurrency"
          value={state.concurrency}
          disabled={state.busyAction === "concurrency"}
          className="min-h-9 rounded-md border border-neutral-300 bg-white px-2 text-sm font-medium dark:border-neutral-700 dark:bg-neutral-950"
          onChange={(event) =>
            void actions
              .setConcurrency(Number(event.target.value) as 1 | 2 | 4)
              .catch(() => undefined)
          }
        >
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
      </label>

      <details className="group relative">
        <summary className="grid min-h-9 min-w-9 list-none place-items-center rounded-md border border-neutral-300 bg-white text-sm font-medium transition-colors hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900" aria-label="More queue controls">•••</summary>
        <div className="absolute right-0 top-11 z-50 w-64 overflow-hidden rounded-lg border border-neutral-200 bg-white p-1 shadow-xl dark:border-neutral-800 dark:bg-neutral-950">
          <button
            type="button"
            className="block w-full rounded-md px-3 py-2.5 text-left text-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-900 [&>small]:mt-0.5 [&>small]:block [&>small]:text-xs [&>small]:text-neutral-500"
            onClick={() => void actions.cleanup("succeeded").catch(() => undefined)}
          >
            <span>Clear completed</span>
            <small>Remove succeeded jobs</small>
          </button>
          <button
            type="button"
            className="block w-full rounded-md px-3 py-2.5 text-left text-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-neutral-900 [&>small]:mt-0.5 [&>small]:block [&>small]:text-xs [&>small]:text-neutral-500"
            onClick={() => void actions.cleanup("terminal").catch(() => undefined)}
          >
            <span>Clear terminal</span>
            <small>Remove all stopped jobs</small>
          </button>
          <button
            className="block w-full rounded-md px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-500 dark:text-red-400 dark:hover:bg-red-950/40 [&>small]:mt-0.5 [&>small]:block [&>small]:text-xs [&>small]:text-red-500/70"
            type="button"
            onClick={() => setConfirmReset(true)}
          >
            <span>Reset playground</span>
            <small>Discard every in-tab job</small>
          </button>
        </div>
      </details>

      <BeUiMorphingModal open={confirmReset} onClose={() => setConfirmReset(false)}>
            <strong className="text-base" id="reset-title">Reset this browser queue?</strong>
            <p className="mt-1 text-sm leading-5 text-neutral-500">Active work stops and every in-tab job is discarded.</p>
            <div className="mt-5 flex justify-end gap-2">
            <BeUiButton type="button" onClick={() => setConfirmReset(false)}>Cancel</BeUiButton>
            <BeUiButton
              variant="danger"
              type="button"
              onClick={() => {
                setConfirmReset(false);
                void actions.reset().catch(() => undefined);
              }}
            >
              Reset queue
            </BeUiButton>
            </div>
      </BeUiMorphingModal>
    </div>
  );
}
