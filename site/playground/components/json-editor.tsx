import { forwardRef, useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "../lib/utils";
import { monoLabelClass } from "./ui/layout";

export const JsonEditor = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    onSubmitShortcut: () => void;
    error?: string;
  }
>(function JsonEditor({ value, onChange, onSubmitShortcut, error }, ref) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [editorMessage, setEditorMessage] = useState<string>();
  const jsonSummary = useMemo(() => {
    try {
      JSON.parse(value);
      const lines = value.split("\n").length;
      return `Valid JSON · ${lines} ${lines === 1 ? "line" : "lines"}`;
    } catch {
      return "Draft JSON";
    }
  }, [value]);

  const format = () => {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
      setEditorMessage("JSON formatted");
    } catch (cause) {
      setEditorMessage(cause instanceof Error ? cause.message : "Fix the JSON before formatting.");
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    onSubmitShortcut();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    window.setTimeout(() => setCopyStatus("idle"), 1_400);
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-neutral-950", error ? "border-red-500" : "border-neutral-800")}>
      <div className="flex min-h-10 items-center justify-between border-b border-white/10 px-3">
        <label className={monoLabelClass} htmlFor="job-payload">JSON input</label>
        <div className="flex items-center gap-1">
          <button className="min-h-8 rounded px-2 font-mono text-[11px] text-neutral-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-blue-400" type="button" onClick={format}>Format</button>
          <button className="min-h-8 rounded px-2 font-mono text-[11px] text-neutral-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-blue-400" type="button" onClick={() => void copy()}>
            {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}
          </button>
        </div>
      </div>
      <textarea
        ref={ref}
        id="job-payload"
        name="job-payload"
        value={value}
        autoComplete="off"
        onChange={(event) => {
          setEditorMessage(undefined);
          onChange(event.target.value);
        }}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "payload-error" : "payload-hint"}
        className="min-h-44 w-full resize-y border-0 bg-transparent px-3 py-3 font-mono text-[13px] leading-6 text-neutral-100 outline-none selection:bg-blue-700 md:min-h-52"
      />
      {error ? (
        <p className="border-t border-red-500/30 bg-red-950/40 px-3 py-2 text-xs leading-5 text-red-300" id="payload-error" role="alert">{error}</p>
      ) : (
        <p className="border-t border-white/10 px-3 py-2 font-mono text-[10px] leading-4 text-neutral-500" id="payload-hint" aria-live="polite">
          {editorMessage ?? jsonSummary} · Ctrl/⌘ + Enter to enqueue
        </p>
      )}
    </div>
  );
});
