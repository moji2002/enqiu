import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BeUiButton } from "../site/playground/components/beui/button";
import { QueueFlow, type FlowToken } from "../site/playground/components/queue-flow";
import { cn } from "../site/playground/lib/utils";
import { useLandingQueue } from "./use-landing-queue";
import "../site/tailwind.css";

const command = "pnpm add enqiu";

function CopyCommand({ light = false }: { light?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <BeUiButton
      className={cn(
        "min-h-12 min-w-48 justify-between rounded-full px-5 font-mono text-xs",
        light
          ? "border-neutral-200 bg-white text-neutral-950 hover:bg-neutral-100"
          : "border-white/15 bg-white/5 text-white hover:bg-white/10 dark:border-white/15 dark:bg-white/5 dark:text-white",
      )}
      type="button"
      onClick={() => void copy()}
    >
      <span>{command}</span>
      <span className="text-[10px] opacity-55">{copied ? "Copied" : "Copy"}</span>
    </BeUiButton>
  );
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function LiveHero() {
  const [state, actions] = useLandingQueue();
  const tokens = useMemo<FlowToken[]>(() => {
    const active: FlowToken = {
      id: "send-email",
      label: "sendEmail()",
      status:
        state.phase === "working"
          ? "running"
          : state.phase === "complete"
            ? "succeeded"
            : state.phase === "failed"
              ? "failed"
              : "queued",
    };
    return [
      active,
      { id: "resize", label: "resizeImage()", status: "succeeded" },
      { id: "sync", label: "syncAccount()", status: "scheduled" },
      { id: "webhook", label: "deliverWebhook()", status: "idle" },
      { id: "index", label: "indexDocument()", status: "idle" },
    ];
  }, [state.phase]);

  const runLabel = state.running
    ? state.phase === "queued" ? "Entering queue…" : "Worker running…"
    : state.phase === "complete" ? "Run it again" : "Send a real job";

  return (
    <div className="relative mx-auto mt-10 w-full max-w-[1160px] sm:mt-14">
      <QueueFlow
        className="border-white/15"
        tokens={tokens}
        queued={state.phase === "queued" ? 1 : 0}
        running={state.phase === "working" ? 1 : 0}
        concurrency={2}
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_260px]">
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">Actual Enqiu · memory driver</p>
            <strong className="mt-1 block truncate text-sm font-medium text-white">{state.status}</strong>
          </div>
          <span className="font-mono text-xs tabular-nums text-cyan-300">{state.progress}%</span>
        </div>
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/10">
          <i className="block h-full rounded-full bg-gradient-to-r from-violet-400 via-sky-400 to-emerald-300 transition-[width] duration-200" style={{ width: `${state.progress}%` }} />
        </div>
        <output className="mt-2 block truncate font-mono text-[10px] text-white/45" aria-live="polite">{state.result}</output>
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
          <BeUiButton className="rounded-full border-white bg-white text-black hover:bg-neutral-200 dark:border-white dark:bg-white dark:text-black" disabled={state.running} type="button" variant="primary" onClick={() => void actions.run().catch(() => undefined)}>{runLabel}</BeUiButton>
          <BeUiButton className="rounded-full border-white/15 bg-transparent text-white hover:bg-white/10 dark:border-white/15 dark:bg-transparent dark:text-white" type="button" onClick={() => void actions.reset().catch(() => undefined)}>Reset</BeUiButton>
        </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 font-mono text-[10px] leading-5 text-white/55">
          <span className="text-violet-300">queue.sendEmail</span>({`{`} to {`}`})
          <br />↓ typed JobHandle
          <br />↓ retryable execution
          <br /><span className="text-emerald-300">result: Promise&lt;Output&gt;</span>
        </div>
      </div>
    </div>
  );
}

function FlowLine({ label, detail, tone }: { label: string; detail: string; tone: string }) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-4 border-t border-neutral-200 py-6 sm:grid-cols-[28px_180px_minmax(0,1fr)] sm:gap-6">
      <i className={cn("mt-1.5 size-2 rounded-full", tone)} aria-hidden="true" />
      <strong className="font-mono text-sm font-medium">{label}</strong>
      <p className="col-start-2 max-w-xl text-sm leading-6 text-neutral-500 sm:col-start-3">{detail}</p>
    </div>
  );
}

function CodeWindow() {
  return (
    <div className="overflow-hidden rounded-[28px] border border-neutral-800 bg-[#090a0d] text-white shadow-2xl shadow-black/15">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-4 font-mono text-[10px] text-white/40">
        <span>jobs.ts</span><span>TypeScript</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[11px] leading-6 text-neutral-300 sm:p-8 sm:text-xs"><code><span className="text-fuchsia-300">import</span> {`{ enqiu }`} <span className="text-fuchsia-300">from</span> <span className="text-amber-200">&quot;enqiu&quot;</span>{"\n\n"}<span className="text-fuchsia-300">const</span> jobs = <span className="text-sky-300">enqiu</span>({`{`}{"\n  "}<span className="text-emerald-300">sendEmail</span>: <span className="text-fuchsia-300">async</span> ({`{ to }`}, ctx) =&gt; {`{`}{"\n    "}<span className="text-fuchsia-300">await</span> ctx.log(<span className="text-amber-200">&quot;info&quot;</span>, <span className="text-amber-200">&quot;Sending&quot;</span>){"\n    "}<span className="text-fuchsia-300">return</span> mail.send(to){"\n  }\n"}{`}`}){"\n\n"}<span className="text-fuchsia-300">const</span> job = <span className="text-fuchsia-300">await</span> jobs.<span className="text-emerald-300">sendEmail</span>({`{ to }`}, {`{`}{"\n  retries: 3,"}{"\n  idempotencyKey: order.id"}{"\n"}{`}`}){"\n\n"}<span className="text-fuchsia-300">const</span> receipt = <span className="text-fuchsia-300">await</span> job.result</code></pre>
      <div className="grid grid-cols-3 border-t border-white/10 font-mono text-[10px]">
        <span className="p-4 text-amber-200">queued</span>
        <span className="border-x border-white/10 p-4 text-sky-300">running</span>
        <span className="p-4 text-emerald-300">succeeded</span>
      </div>
    </div>
  );
}

export function LandingApp() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-[#f7f7f4] font-sans text-neutral-950 antialiased selection:bg-violet-200">
      <a className="fixed left-3 top-3 z-[100] -translate-y-24 rounded-full bg-white px-4 py-2 text-sm font-medium text-black transition-transform focus:translate-y-0" href="#content">Skip to content</a>
      <div className="relative overflow-hidden bg-[#090a0d] text-white">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_10%_10%,rgb(124_92_255/0.18),transparent_24%),radial-gradient(circle_at_90%_30%,rgb(255_91_122/0.12),transparent_24%)]" />
        <header className="relative z-50 mx-auto flex min-h-20 max-w-[1380px] items-center justify-between px-5 sm:px-8">
          <a className="text-xl font-semibold tracking-[-0.055em]" href="#top">enqiu<span className="text-violet-400">/</span></a>
          <nav className="flex items-center gap-1 text-sm" aria-label="Primary navigation">
            <a className="hidden rounded-full px-4 py-2 text-white/55 transition-colors hover:bg-white/5 hover:text-white sm:block" href="#model">How it works</a>
            <a className="hidden rounded-full px-4 py-2 text-white/55 transition-colors hover:bg-white/5 hover:text-white sm:block" href="https://github.com/moji2002/enqiu">GitHub <Arrow /></a>
            <a className="ml-1 inline-flex min-h-11 items-center rounded-full bg-white px-5 font-medium text-black transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-400" href="/playground">Open playground</a>
          </nav>
        </header>

        <main id="content">
          <section className="relative mx-auto max-w-[1380px] px-5 pb-16 pt-12 sm:px-8 sm:pb-24 sm:pt-20" id="top">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-violet-300">Typed background jobs · frontend included</p>
              <h1 className="mt-6 max-w-5xl text-[clamp(3.5rem,9vw,8.5rem)] font-semibold leading-[0.82] tracking-[-0.075em]">Make work<br /><span className="text-white/38">move.</span></h1>
              <div className="mt-8 grid max-w-5xl gap-8 sm:grid-cols-[minmax(0,520px)_auto] sm:items-end">
                <p className="text-lg leading-8 text-white/58 sm:text-xl">Enqiu turns typed functions into observable jobs—with retries, schedules, progress, cancellation, and drivers for the browser or server.</p>
                <div className="flex flex-wrap gap-3 sm:justify-end"><CopyCommand /></div>
              </div>
            </div>
            <LiveHero />
          </section>
        </main>
      </div>

      <section className="mx-auto grid max-w-[1280px] gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[0.8fr_1.2fr] lg:gap-24" id="model" aria-labelledby="model-title">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-violet-700">The mental model</p>
          <h2 className="mt-5 max-w-md text-4xl font-semibold leading-[0.95] tracking-[-0.055em] sm:text-6xl" id="model-title">A function call with a life after return.</h2>
        </div>
        <div className="border-b border-neutral-200">
          <FlowLine tone="bg-amber-400" label="01 · Enter" detail="Call a typed handler. Enqiu stores the input, options, and identity as an inspectable job." />
          <FlowLine tone="bg-sky-500" label="02 · Move" detail="Workers claim available jobs. Concurrency, delay, timeout, retries, and cancellation shape the route." />
          <FlowLine tone="bg-emerald-500" label="03 · Resolve" detail="Await the typed result or observe progress, logs, errors, and lifecycle events while work happens." />
        </div>
      </section>

      <section className="border-y border-neutral-200 bg-white" aria-labelledby="code-title">
        <div className="mx-auto grid max-w-[1280px] gap-12 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:gap-24">
          <CodeWindow />
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-sky-700">One contract, two worlds</p>
            <h2 className="mt-5 text-4xl font-semibold leading-[0.96] tracking-[-0.055em] sm:text-6xl" id="code-title">Use it in the frontend, too.</h2>
            <p className="mt-6 max-w-lg text-lg leading-8 text-neutral-500">The memory driver runs in the browser, so UI prototypes and local tools can use the actual library. Move to Redis when work needs to outlive the process—the handler API stays familiar.</p>
            <dl className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-200 text-sm">
              <div className="bg-[#f7f7f4] p-5"><dt className="font-mono text-[10px] uppercase text-neutral-400">Local</dt><dd className="mt-8 font-medium">Browser · Node · Bun</dd></div>
              <div className="bg-[#f7f7f4] p-5"><dt className="font-mono text-[10px] uppercase text-neutral-400">Durable</dt><dd className="mt-8 font-medium">Redis driver</dd></div>
              <div className="bg-[#f7f7f4] p-5"><dt className="font-mono text-[10px] uppercase text-neutral-400">Types</dt><dd className="mt-8 font-medium">Input → result</dd></div>
              <div className="bg-[#f7f7f4] p-5"><dt className="font-mono text-[10px] uppercase text-neutral-400">Control</dt><dd className="mt-8 font-medium">AbortSignal</dd></div>
            </dl>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-5 py-20 sm:px-8 sm:py-28" aria-labelledby="cta-title">
        <div className="relative overflow-hidden rounded-[32px] bg-[#6857f5] px-6 py-16 text-white sm:px-12 sm:py-20">
          <div className="absolute -right-20 -top-24 size-72 rounded-full border-[44px] border-white/10" aria-hidden="true" />
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/65">Nothing mocked</p>
          <h2 className="relative mt-5 max-w-3xl text-4xl font-semibold leading-[0.94] tracking-[-0.055em] sm:text-7xl" id="cta-title">Touch the queue.<br />Break it. Retry it.</h2>
          <p className="relative mt-6 max-w-xl text-lg leading-8 text-white/72">The playground runs the package in your browser. Queue real jobs, change worker concurrency, pause execution, and inspect every state.</p>
          <div className="relative mt-9 flex flex-col gap-3 sm:flex-row">
            <a className="inline-flex min-h-12 items-center justify-center rounded-full bg-white px-6 text-sm font-medium text-neutral-950 transition-transform hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white" href="/playground">Launch playground&nbsp; <Arrow /></a>
            <CopyCommand />
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-[1280px] flex-col gap-3 border-t border-neutral-200 px-5 py-8 font-mono text-[10px] uppercase tracking-wider text-neutral-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span>Enqiu · queues without ceremony</span><span>MIT · frontend + server</span>
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Landing root element is missing");
createRoot(root).render(<LandingApp />);
