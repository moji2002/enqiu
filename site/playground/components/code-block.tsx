import { useState } from "react";

export function CodeBlock({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

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
    <div className="code-block">
      <div className="code-block-bar">
        <span>{label}</span>
        <button type="button" onClick={() => void copy()}>
          {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>{value}</pre>
    </div>
  );
}
