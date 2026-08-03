import { useState } from "react";
import type { PlaygroundActions, PlaygroundState } from "../types";

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
    <div className="queue-toolbar" aria-label="Worker controls">
      <div className="worker-readout">
        <span className={state.paused ? "worker-light paused" : "worker-light"} />
        <span>
          <strong>{state.paused ? "Worker paused" : "Worker running"}</strong>
          <small>{runningLabel} slots occupied</small>
        </span>
      </div>

      <button
        className="pause-button"
        type="button"
        disabled={state.busyAction === "pause" || state.busyAction === "resume"}
        onClick={() => void actions.setPaused(!state.paused).catch(() => undefined)}
      >
        {state.paused ? "Resume" : "Pause"}
      </button>

      <div className="concurrency-picker" aria-label="Worker concurrency">
        <span>Concurrency</span>
        {[1, 2, 4].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={state.concurrency === value}
            disabled={state.busyAction === "concurrency"}
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

      <label className="concurrency-select">
        <span className="sr-only">Worker concurrency</span>
        <select
          name="worker-concurrency"
          aria-label="Worker concurrency"
          value={state.concurrency}
          disabled={state.busyAction === "concurrency"}
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

      <details className="queue-menu">
        <summary aria-label="More queue controls">•••</summary>
        <div className="queue-menu-popover">
          <button
            type="button"
            onClick={() => void actions.cleanup("succeeded").catch(() => undefined)}
          >
            <span>Clear completed</span>
            <small>Remove succeeded jobs</small>
          </button>
          <button
            type="button"
            onClick={() => void actions.cleanup("terminal").catch(() => undefined)}
          >
            <span>Clear terminal</span>
            <small>Remove all stopped jobs</small>
          </button>
          <button
            className="danger-option"
            type="button"
            onClick={() => setConfirmReset(true)}
          >
            <span>Reset playground</span>
            <small>Discard every in-tab job</small>
          </button>
        </div>
      </details>

      {confirmReset ? (
        <div className="reset-confirmation" role="dialog" aria-modal="true" aria-labelledby="reset-title">
          <div>
            <strong id="reset-title">Reset this browser queue?</strong>
            <p>Active work stops and every in-tab job is discarded.</p>
          </div>
          <div>
            <button type="button" onClick={() => setConfirmReset(false)}>Cancel</button>
            <button
              className="confirm-reset"
              type="button"
              onClick={() => {
                setConfirmReset(false);
                void actions.reset().catch(() => undefined);
              }}
            >
              Reset queue
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
