import { forwardRef, useMemo, useState, type KeyboardEvent } from "react";

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
    <div className="json-editor" data-invalid={Boolean(error)}>
      <div className="editor-bar">
        <label htmlFor="job-payload">JSON input</label>
        <div>
          <button type="button" onClick={format}>Format</button>
          <button type="button" onClick={() => void copy()}>
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
      />
      {error ? (
        <p className="field-error" id="payload-error" role="alert">{error}</p>
      ) : (
        <p className="field-hint" id="payload-hint" aria-live="polite">
          {editorMessage ?? jsonSummary} · Ctrl/⌘ + Enter to enqueue
        </p>
      )}
    </div>
  );
});
