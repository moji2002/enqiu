import { useState } from "react";
import { BeUiButton } from "./beui/button";

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
    <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex min-h-10 items-center justify-between border-b border-white/10 px-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-500">{label}</span>
        <BeUiButton className="min-h-7 border-0 bg-transparent px-2 font-mono text-[10px] text-neutral-400 hover:bg-white/10 hover:text-white" size="sm" variant="ghost" type="button" onClick={() => void copy()}>
          {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy failed" : "Copy"}
        </BeUiButton>
      </div>
      <pre className="max-h-80 overflow-auto p-3 font-mono text-[11px] leading-5 text-neutral-300 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500" tabIndex={0}>{value}</pre>
    </div>
  );
}
