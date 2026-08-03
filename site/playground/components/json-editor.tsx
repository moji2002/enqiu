import { forwardRef, useState } from "react";

export const JsonEditor = forwardRef<
  HTMLTextAreaElement,
  {
    value: string;
    onChange: (value: string) => void;
    error?: string;
  }
>(function JsonEditor({ value, onChange, error }, ref) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const format = () => {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      // Submission validation owns the specific parse message.
    }
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "payload-error" : "payload-hint"}
      />
      {error ? (
        <p className="field-error" id="payload-error" role="alert">{error}</p>
      ) : (
        <p className="field-hint" id="payload-hint">Editable input—never arbitrary code.</p>
      )}
    </div>
  );
});
