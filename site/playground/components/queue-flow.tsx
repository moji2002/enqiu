import { cn } from "../lib/utils";

export type FlowToken = {
  id: string;
  label: string;
  status: "queued" | "scheduled" | "running" | "succeeded" | "failed" | "cancelled" | "expired" | "idle";
};

const statusTone: Record<FlowToken["status"], string> = {
  queued: "border-amber-300/25 bg-amber-300/10 text-amber-200",
  scheduled: "border-violet-300/25 bg-violet-300/10 text-violet-200",
  running: "border-sky-300/30 bg-sky-300/10 text-sky-200",
  succeeded: "border-emerald-300/25 bg-emerald-300/10 text-emerald-200",
  failed: "border-rose-300/25 bg-rose-300/10 text-rose-200",
  cancelled: "border-white/10 bg-white/[0.03] text-neutral-400",
  expired: "border-orange-300/25 bg-orange-300/10 text-orange-200",
  idle: "border-white/8 bg-white/[0.02] text-neutral-600",
};

const statusDot: Record<FlowToken["status"], string> = {
  queued: "bg-amber-300",
  scheduled: "bg-violet-400",
  running: "bg-sky-300",
  succeeded: "bg-emerald-300",
  failed: "bg-rose-300",
  cancelled: "bg-neutral-500",
  expired: "bg-orange-300",
  idle: "bg-neutral-700",
};

function TokenCard({ token, onSelect }: { token: FlowToken; onSelect?: (id: string) => void }) {
  const interactive = token.status !== "idle" && Boolean(onSelect);
  return (
    <button
      className={cn(
        "grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border px-3 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300",
        statusTone[token.status],
        interactive ? "cursor-pointer hover:border-white/25 hover:bg-white/[0.07]" : "cursor-default",
      )}
      type="button"
      disabled={!interactive}
      onClick={() => interactive && onSelect?.(token.id)}
    >
      <i className={cn("size-2 rounded-full", statusDot[token.status])} aria-hidden="true" />
      <span className="min-w-0">
        <strong className="block truncate font-mono text-[11px] font-medium">{token.label}</strong>
        <small className="mt-0.5 block font-mono text-[9px] uppercase tracking-wider opacity-55">{token.status}</small>
      </span>
    </button>
  );
}

function EmptyRow({ children }: { children: string }) {
  return <div className="grid min-h-14 place-items-center rounded-xl border border-dashed border-white/10 px-3 text-center font-mono text-[9px] uppercase tracking-wider text-neutral-600">{children}</div>;
}

function LaneHeader({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 border-b border-white/10 pb-3">
      <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-500"><i className={cn("size-1.5 rounded-full", tone)} />{label}</span>
      <strong className="font-mono text-[10px] font-medium text-neutral-400">{count}</strong>
    </div>
  );
}

export function QueueFlow({
  tokens,
  running,
  queued,
  concurrency,
  paused = false,
  onSelect,
  className,
  compact = false,
}: {
  tokens: readonly FlowToken[];
  running: number;
  queued: number;
  concurrency: number;
  paused?: boolean;
  onSelect?: (id: string) => void;
  className?: string;
  compact?: boolean;
}) {
  const waiting = tokens.filter((token) => token.status === "queued" || token.status === "scheduled" || token.status === "idle").slice(0, compact ? 3 : 5);
  const active = tokens.filter((token) => token.status === "running");
  const finished = tokens.filter((token) => token.status === "succeeded" || token.status === "failed" || token.status === "cancelled" || token.status === "expired").slice(0, compact ? 3 : 5);
  const slots = Array.from({ length: concurrency }, (_, index) => active[index]);

  return (
    <section
      className={cn("relative flex flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#090a0d] text-white shadow-2xl shadow-black/20", className)}
      aria-label={`${queued} waiting, ${running} running, concurrency ${concurrency}`}
    >
      <div className="flex min-h-14 items-center justify-between gap-4 border-b border-white/10 px-4 sm:px-5">
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-neutral-400"><i className={cn("size-2 rounded-full", paused ? "bg-amber-400" : "bg-emerald-400")} />{paused ? "Worker paused" : "Queue live"}</span>
        <span className="font-mono text-[10px] text-neutral-600">{running}/{concurrency} slots active</span>
      </div>

      <div className={cn("grid flex-1 gap-0 p-3 sm:p-5 md:grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)_44px_minmax(0,1fr)]", compact ? "min-h-[360px]" : "min-h-[520px]")}>
        <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3 sm:p-4">
          <LaneHeader label="Waiting" count={queued} tone="bg-amber-300" />
          <div className="space-y-2">{waiting.length ? waiting.map((token) => <TokenCard key={token.id} token={token} onSelect={onSelect} />) : <EmptyRow>Queue is clear</EmptyRow>}</div>
        </div>

        <div className="grid min-h-12 place-items-center font-mono text-lg text-white/20" aria-hidden="true"><span className="rotate-90 md:rotate-0">→</span></div>

        <div className={cn("rounded-2xl border p-3 sm:p-4", paused ? "border-amber-300/20 bg-amber-300/[0.04]" : "border-sky-300/20 bg-sky-300/[0.04]")}>
          <LaneHeader label={paused ? "Gate closed" : "Workers"} count={running} tone={paused ? "bg-amber-300" : "bg-sky-300"} />
          <div className="space-y-2">
            {slots.map((token, index) => token ? <TokenCard key={token.id} token={token} onSelect={onSelect} /> : (
              <div className="grid min-h-14 grid-cols-[28px_minmax(0,1fr)] items-center gap-3 rounded-xl border border-white/8 bg-black/20 px-3" key={index}>
                <span className="grid size-7 place-items-center rounded-md border border-white/10 font-mono text-[9px] text-neutral-600">{index + 1}</span>
                <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-600">{paused ? "Paused" : "Available"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid min-h-12 place-items-center font-mono text-lg text-white/20" aria-hidden="true"><span className="rotate-90 md:rotate-0">→</span></div>

        <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-3 sm:p-4">
          <LaneHeader label="Outcomes" count={finished.length} tone="bg-emerald-300" />
          <div className="space-y-2">{finished.length ? finished.map((token) => <TokenCard key={token.id} token={token} onSelect={onSelect} />) : <EmptyRow>Results appear here</EmptyRow>}</div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-white/10 px-4 py-3 font-mono text-[9px] uppercase tracking-wider text-neutral-600 sm:px-5">
        <span>Input</span><span>Claim + execute</span><span>Result</span>
      </div>
    </section>
  );
}
