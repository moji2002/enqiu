import { useEffect, useRef, useState } from "react";
import { defaultDraft, RECIPES, recipeFor } from "../queue";
import type { ComposerDraft, RecipeId } from "../types";
import { JsonEditor } from "./json-editor";
import { BeUiButton } from "./beui/button";
import { BeUiCheckbox } from "./beui/checkbox";
import { BeUiInput } from "./beui/input";
import {
  Panel,
  PanelHeader,
  fieldClass,
  fieldLabelClass,
  monoLabelClass,
} from "./ui/layout";

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
    <Panel className="h-full overflow-hidden" aria-labelledby="composer-title">
      <PanelHeader number="01" title="Compose" description="Choose a handler, edit the input, then enqueue." />

      <div className="space-y-4 p-4">
      <fieldset>
        <legend className={monoLabelClass}>Job handler</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3 md:grid-cols-1">
        {RECIPES.map((recipe) => (
          <button
            key={recipe.id}
            type="button"
            className="group flex min-h-14 min-w-0 items-center gap-3 rounded-lg border border-neutral-200 p-2.5 text-left transition duration-200 hover:border-neutral-400 hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 aria-pressed:border-black aria-pressed:bg-neutral-950 aria-pressed:text-white dark:border-neutral-800 dark:hover:border-neutral-600 dark:hover:bg-neutral-900 dark:aria-pressed:border-white dark:aria-pressed:bg-white dark:aria-pressed:text-black"
            aria-pressed={draft.recipe === recipe.id}
            onClick={() => chooseRecipe(recipe.id)}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md border border-current/15 bg-neutral-100 font-mono text-xs font-semibold text-neutral-600 group-aria-pressed:bg-white/10 group-aria-pressed:text-current dark:bg-neutral-900">
              {recipe.id.slice(0, 1)}
            </span>
            <span className="min-w-0">
              <strong className="block truncate font-mono text-xs font-medium">{recipe.id}()</strong>
              <small className="mt-0.5 block truncate text-[11px] text-neutral-500 group-aria-pressed:text-neutral-400 dark:group-aria-pressed:text-neutral-600">{recipe.capability}</small>
            </span>
          </button>
        ))}
        </div>
      </fieldset>

      <p className="text-sm leading-5 text-neutral-500 dark:text-neutral-400">{currentRecipe.description}</p>

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

      <div className="grid grid-cols-2 gap-3">
        <label>
          <span className={fieldLabelClass}>Priority</span>
          <select
            className={fieldClass}
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
          <span className={fieldLabelClass}>Delay</span>
          <select
            className={fieldClass}
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

      <details className="rounded-lg border border-neutral-200 open:bg-neutral-50 dark:border-neutral-800 dark:open:bg-neutral-900/40">
        <summary className="flex min-h-11 list-none items-center justify-between px-3 text-sm font-medium after:text-neutral-400 after:content-['+'] hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-blue-500 group-open:after:content-['−'] dark:hover:bg-neutral-900">Advanced options</summary>
        <div className="grid grid-cols-2 gap-3 border-t border-neutral-200 p-3 dark:border-neutral-800">
          <label>
            <span className={fieldLabelClass}>Attempts</span>
            <select
              className={fieldClass}
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
          <div>
            <BeUiInput
              label="Timeout (ms)"
              type="number"
              name="timeout"
              min={1}
              inputMode="numeric"
              autoComplete="off"
              placeholder="No limit…"
              value={draft.timeoutMs ?? ""}
              onValueChange={(value) =>
                update(
                  "timeoutMs",
                  value ? Number(value) : undefined,
                )
              }
            />
          </div>
          <div>
            <BeUiInput
              label="Expires in (ms)"
              type="number"
              name="expiry"
              min={1}
              inputMode="numeric"
              autoComplete="off"
              placeholder="Never…"
              value={draft.expiresInMs ?? ""}
              onValueChange={(value) =>
                update(
                  "expiresInMs",
                  value ? Number(value) : undefined,
                )
              }
            />
          </div>
          <div>
            <BeUiInput
              label="Custom ID"
              type="text"
              name="custom-id"
              autoComplete="off"
              spellCheck={false}
              placeholder="Auto-generated…"
              value={draft.customId ?? ""}
              onValueChange={(value) => update("customId", value || undefined)}
            />
          </div>
          <div className="col-span-2">
            <BeUiInput
              label="Idempotency key"
              type="text"
              name="idempotency-key"
              autoComplete="off"
              spellCheck={false}
              placeholder="Optional single-flight key…"
              value={draft.idempotencyKey ?? ""}
              onValueChange={(value) =>
                update("idempotencyKey", value || undefined)
              }
            />
          </div>
          {currentRecipe.supportsFailure ? (
            <BeUiCheckbox className="col-span-2 rounded-md border border-neutral-200 px-3 dark:border-neutral-800" checked={draft.failOnce} onCheckedChange={(checked) => update("failOnce", checked)} label="Fail once, then retry" />
          ) : null}
        </div>
      </details>

      <BeUiButton
        variant="primary"
        className="w-full justify-between px-4"
        type="button"
        disabled={busyAction === "enqueue"}
        onClick={() => void submit()}
      >
        <span>{busyAction === "enqueue" ? "Queueing…" : "Enqueue job"}</span>
        <kbd className="rounded border border-white/20 px-1.5 py-0.5 font-mono text-[10px] font-normal text-neutral-300 dark:border-black/20 dark:text-neutral-600" aria-hidden="true">Ctrl/⌘ ↵</kbd>
      </BeUiButton>

      <div className="border-t border-neutral-200 pt-4 dark:border-neutral-800" aria-label="Queue scenarios">
        <span className={monoLabelClass}>Try queue behavior</span>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <BeUiButton className="min-w-0 px-2 text-xs" type="button" disabled={busyAction === "queue-three"} onClick={() => void runScenario("queue-three")}>
            {busyAction === "queue-three" ? "Queueing…" : "Queue three"}
          </BeUiButton>
          <BeUiButton className="min-w-0 px-2 text-xs" type="button" disabled={busyAction === "fail-once"} onClick={() => void runScenario("fail-once")}>
            {busyAction === "fail-once" ? "Queueing…" : "Fail once"}
          </BeUiButton>
          <BeUiButton className="min-w-0 px-2 text-xs" type="button" disabled={busyAction === "schedule-five"} onClick={() => void runScenario("schedule-five")}>
            {busyAction === "schedule-five" ? "Scheduling…" : "Schedule +5s"}
          </BeUiButton>
        </div>
      </div>
      </div>
    </Panel>
  );
}
