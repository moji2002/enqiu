import { useEffect, useRef, useState } from "react";
import { defaultDraft, RECIPES, recipeFor } from "../queue";
import type { ComposerDraft, RecipeId } from "../types";
import { JsonEditor } from "./json-editor";

const STORAGE_KEY = "enqiu.playground.composer.v1";

function restoreDraft(value: string | null): ComposerDraft | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<ComposerDraft>;
    if (
      parsed.recipe !== "sendEmail" &&
      parsed.recipe !== "resizeImage" &&
      parsed.recipe !== "syncAccount"
    ) {
      return undefined;
    }
    if (typeof parsed.payload !== "string") return undefined;
    return {
      ...defaultDraft(parsed.recipe),
      ...parsed,
      recipe: parsed.recipe,
      payload: parsed.payload,
    };
  } catch {
    return undefined;
  }
}

export function JobComposer({
  draft,
  onDraftChange,
  onEnqueue,
  onScenario,
  busyAction,
}: {
  draft: ComposerDraft;
  onDraftChange: (draft: ComposerDraft) => void;
  onEnqueue: (draft: ComposerDraft) => Promise<void>;
  onScenario: (
    kind: "queue-three" | "fail-once" | "schedule-five",
    draft: ComposerDraft,
  ) => Promise<void>;
  busyAction?: string;
}) {
  const [error, setError] = useState<string>();
  const payloads = useRef(new Map<RecipeId, string>([[draft.recipe, draft.payload]]));
  const editor = useRef<HTMLTextAreaElement>(null);
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const stored = restoreDraft(window.sessionStorage.getItem(STORAGE_KEY));
    if (stored) {
      payloads.current.set(stored.recipe, stored.payload);
      onDraftChange(stored);
    }
  }, [onDraftChange]);

  useEffect(() => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
  }, [draft]);

  const update = <Key extends keyof ComposerDraft>(
    key: Key,
    value: ComposerDraft[Key],
  ) => {
    setError(undefined);
    onDraftChange({ ...draft, [key]: value });
  };

  const chooseRecipe = (recipe: RecipeId) => {
    payloads.current.set(draft.recipe, draft.payload);
    const nextPayload =
      payloads.current.get(recipe) ??
      JSON.stringify(recipeFor(recipe).defaultPayload, null, 2);
    const next = {
      ...defaultDraft(recipe),
      payload: nextPayload,
      priority: draft.priority,
      delayMs: draft.delayMs,
      retryAttempts: draft.retryAttempts,
    };
    onDraftChange(next);
    setError(undefined);
  };

  const submit = async () => {
    setError(undefined);
    try {
      await onEnqueue(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not enqueue this job.");
      editor.current?.focus();
    }
  };

  const runScenario = async (
    kind: "queue-three" | "fail-once" | "schedule-five",
  ) => {
    setError(undefined);
    try {
      await onScenario(kind, draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start this scenario.");
    }
  };

  const currentRecipe = recipeFor(draft.recipe);

  return (
    <section className="composer" aria-labelledby="composer-title">
      <div className="section-heading">
        <div>
          <h2 id="composer-title">Compose</h2>
          <p>Choose a handler, adjust its input, enqueue.</p>
        </div>
        <span className="step-mark">01</span>
      </div>

      <fieldset className="recipe-picker">
        <legend>Job recipe</legend>
        {RECIPES.map((recipe) => (
          <button
            key={recipe.id}
            type="button"
            className="recipe-option"
            aria-pressed={draft.recipe === recipe.id}
            onClick={() => chooseRecipe(recipe.id)}
          >
            <span className="recipe-glyph" aria-hidden="true">
              {recipe.id.slice(0, 1)}
            </span>
            <span>
              <strong>{recipe.id}()</strong>
              <small>{recipe.capability}</small>
            </span>
          </button>
        ))}
      </fieldset>

      <p className="recipe-description">{currentRecipe.description}</p>

      <JsonEditor
        ref={editor}
        value={draft.payload}
        error={error}
        onSubmitShortcut={() => void submit()}
        onChange={(payload) => {
          payloads.current.set(draft.recipe, payload);
          update("payload", payload);
        }}
      />

      <div className="common-options">
        <label>
          <span>Priority</span>
          <select
            name="priority"
            value={draft.priority}
            autoComplete="off"
            onChange={(event) =>
              update("priority", event.target.value as ComposerDraft["priority"])
            }
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          <span>Delay</span>
          <select
            name="delay"
            value={draft.delayMs}
            autoComplete="off"
            onChange={(event) =>
              update("delayMs", Number(event.target.value) as ComposerDraft["delayMs"])
            }
          >
            <option value={0}>None</option>
            <option value={2_000}>2 seconds</option>
            <option value={5_000}>5 seconds</option>
          </select>
        </label>
      </div>

      <details className="advanced-options">
        <summary>Advanced options</summary>
        <div className="advanced-grid">
          <label>
            <span>Attempts</span>
            <select
              name="attempts"
              value={draft.retryAttempts}
              autoComplete="off"
              onChange={(event) =>
                update(
                  "retryAttempts",
                  Number(event.target.value) as ComposerDraft["retryAttempts"],
                )
              }
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label>
            <span>Timeout (ms)</span>
            <input
              type="number"
              name="timeout"
              min={1}
              inputMode="numeric"
              autoComplete="off"
              placeholder="No limit…"
              value={draft.timeoutMs ?? ""}
              onChange={(event) =>
                update(
                  "timeoutMs",
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
            />
          </label>
          <label>
            <span>Expires in (ms)</span>
            <input
              type="number"
              name="expiry"
              min={1}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Never…"
              value={draft.expiresInMs ?? ""}
              onChange={(event) =>
                update(
                  "expiresInMs",
                  event.target.value ? Number(event.target.value) : undefined,
                )
              }
            />
          </label>
          <label>
            <span>Custom ID</span>
            <input
              type="text"
              name="custom-id"
              autoComplete="off"
              spellCheck={false}
              placeholder="Auto-generated…"
              value={draft.customId ?? ""}
              onChange={(event) => update("customId", event.target.value || undefined)}
            />
          </label>
          <label className="wide-field">
            <span>Idempotency key</span>
            <input
              type="text"
              name="idempotency-key"
              autoComplete="off"
              spellCheck={false}
              placeholder="Optional single-flight key…"
              value={draft.idempotencyKey ?? ""}
              onChange={(event) =>
                update("idempotencyKey", event.target.value || undefined)
              }
            />
          </label>
          {currentRecipe.supportsFailure ? (
            <label className="check-field wide-field">
              <input
                type="checkbox"
                checked={draft.failOnce}
                onChange={(event) => update("failOnce", event.target.checked)}
              />
              <span>Fail once, then retry</span>
            </label>
          ) : null}
        </div>
      </details>

      <button
        className="enqueue-primary"
        type="button"
        disabled={busyAction === "enqueue"}
        onClick={() => void submit()}
      >
        <span>{busyAction === "enqueue" ? "Queueing…" : "Enqueue job"}</span>
        <kbd aria-hidden="true">Ctrl/⌘ ↵</kbd>
      </button>

      <div className="scenario-row" aria-label="Queue scenarios">
        <span>Try a behavior</span>
        <div>
          <button type="button" disabled={busyAction === "queue-three"} onClick={() => void runScenario("queue-three")}>
            {busyAction === "queue-three" ? "Queueing…" : "Queue three"}
          </button>
          <button type="button" disabled={busyAction === "fail-once"} onClick={() => void runScenario("fail-once")}>
            {busyAction === "fail-once" ? "Queueing…" : "Fail once"}
          </button>
          <button type="button" disabled={busyAction === "schedule-five"} onClick={() => void runScenario("schedule-five")}>
            {busyAction === "schedule-five" ? "Scheduling…" : "Schedule +5s"}
          </button>
        </div>
      </div>
    </section>
  );
}
