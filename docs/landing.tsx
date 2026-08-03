import { useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { useLandingQueue } from "./use-landing-queue";

function Signal() {
  return <span className="signal" aria-hidden="true"><i /><i /><i /></span>;
}

function CopyCommand({ final = false }: { final?: boolean }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText("pnpm add enqiu");
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
    window.setTimeout(() => setStatus("idle"), 1_400);
  };

  const label = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy";
  if (final) {
    return (
      <button className="final-install" type="button" onClick={() => void copy()}>
        pnpm add enqiu <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="install-command">
      <span>pnpm add enqiu</span>
      <button type="button" aria-label="Copy install command" onClick={() => void copy()}>{label}</button>
    </div>
  );
}

function QueuePreview() {
  const [state, actions] = useLandingQueue();
  const buttonLabel = state.running
    ? state.phase === "queued" ? "Queued…" : "Running…"
    : state.phase === "complete" ? "Run again" : state.phase === "failed" ? "Try again" : "Run sendEmail()";

  return (
    <div className="lab-wrap">
      <div className="lab-shadow" aria-hidden="true" />
      <section className="queue-lab" data-state={state.phase} aria-labelledby="lab-heading">
        <h2 id="lab-heading" className="sr-only">Queue lifecycle playground</h2>
        <div className="lab-topline">
          <strong>sendEmail()</strong>
          <span className="real-chip"><i aria-hidden="true" /> Actual Enqiu queue</span>
        </div>
        <div className="lab-code" aria-label="Enqiu code example">
          <span className="violet">const</span> jobs = <span className="coral">enqiu</span>({`{`}<br />
          &nbsp;&nbsp;<span className="mint">sendEmail</span>: <span className="violet">async</span> ({`{ to }`}, ctx) =&gt; {`{`}<br />
          &nbsp;&nbsp;&nbsp;&nbsp;<span className="dim">await</span> ctx.reportProgress({`{ completed: 1, total: 2 }`})<br />
          &nbsp;&nbsp;&nbsp;&nbsp;<span className="violet">return</span> mail.send(to)<br />
          &nbsp;&nbsp;{`}`}<br />
          {`}`} )<br /><br />
          <span className="violet">await</span> jobs.<span className="mint">sendEmail</span>({`{ to: `}<span className="coral">&quot;you@example.com&quot;</span>{` }`})
        </div>
        <div className="lab-stage">
          <div
            className="queue-track"
            data-state={state.phase}
            style={{ "--job-progress": `${state.progress}%` } as CSSProperties}
          >
            <div className="track-line" aria-hidden="true" />
            <span className="runner" aria-hidden="true" />
            <div className="stage-labels" aria-label="Job lifecycle">
              <span data-stage="queued" aria-current={state.phase === "queued" ? "step" : undefined}>Queued</span>
              <span data-stage="working" aria-current={state.phase === "working" ? "step" : undefined}>Working</span>
              <span data-stage="complete" aria-current={state.phase === "complete" ? "step" : undefined}>Result</span>
            </div>
          </div>
          <article className="job-token" data-state={state.phase}>
            <span className="ticket-mark" aria-hidden="true">J</span>
            <div className="job-copy">
              <strong>{state.status}</strong>
              <output className="job-result" aria-live="polite">{state.result}</output>
            </div>
            <span className="status-chip"><i aria-hidden="true" /> Live</span>
          </article>
          <div className="lab-actions">
            <button className="run-job" type="button" onClick={() => void actions.run().catch(() => undefined)}>{buttonLabel}</button>
            <button className="queue-reset" type="button" onClick={() => void actions.reset().catch(() => undefined)}>Reset</button>
          </div>
        </div>
        <div className="lab-footer">
          <span>Nothing simulated—the package runs here.</span>
          <a href="/playground">Open full workbench →</a>
        </div>
      </section>
    </div>
  );
}

export function LandingApp() {
  return (
    <>
      <a className="skip-link" href="#content">Skip to content</a>
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Enqiu home">enqiu<span>.</span></a>
        <nav className="top-links" aria-label="Top navigation">
          <a href="#quick-start">Docs</a>
          <a href="https://github.com/moji2002/enqiu">GitHub ↗</a>
          <a className="nav-primary" href="/playground">Open playground</a>
        </nav>
      </header>

      <main id="content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">Background jobs,<span>called like functions.</span></h1>
            <p>
              Define handlers once. Enqiu gives you typed calls, retries, schedules,
              progress, cancellation, and inspectable history—without a framework around your framework.
            </p>
            <div className="hero-actions">
              <a className="button primary" href="/playground">Try the live queue</a>
              <CopyCommand />
            </div>
            <div className="support-note"><i aria-hidden="true" /> Type-safe jobs in modern browsers, Node.js, and Bun.</div>
          </div>
          <QueuePreview />
        </section>

        <div className="proof-strip" aria-label="Enqiu capabilities">
          <div className="proof-inner">
            <strong>Small API. Serious queue behavior.</strong>
            <span>Type inference</span><span>Retries</span><span>Schedules</span><span>Progress</span><span>Cancellation</span>
          </div>
        </div>

        <section className="section" id="quick-start" aria-labelledby="quick-title">
          <div className="section-heading">
            <div><div className="section-kicker">01 · Define and call</div><h2 id="quick-title">If it looks like a function, use it like one.</h2></div>
            <p>Your handler map becomes the API. Inputs are inferred, job options stay explicit, and every call returns a handle you can await or cancel.</p>
          </div>
          <div className="quick-grid">
            <div className="code-panel">
              <div className="code-title"><span>jobs.ts</span><span>TypeScript</span></div>
              <pre><span className="code-violet">import</span> {`{ enqiu }`} <span className="code-violet">from</span> <span className="code-coral">&quot;enqiu&quot;</span>{`\n\n`}<span className="code-violet">const</span> jobs = <span className="code-mint">enqiu</span>({`{\n  sendEmail: `}<span className="code-violet">async</span> ({`{ to, subject }, ctx) => {\n    `}<span className="code-violet">await</span> ctx.reportProgress({`{\n      completed: `}<span className="code-coral">1</span>, total: <span className="code-coral">2</span>{`\n    })\n    `}<span className="code-violet">return</span> mail.send({`{ to, subject }\n  }\n})\n\n`}<span className="code-violet">const</span> job = <span className="code-violet">await</span> jobs.<span className="token-call">sendEmail</span>({`{\n  to: `}<span className="code-coral">&quot;ada@example.com&quot;</span>{`,\n  subject: `}<span className="code-coral">&quot;It shipped&quot;</span>{`\n})\n\n`}<span className="code-violet">await</span> job.result</pre>
            </div>
            <div className="result-panel">
              <div className="result-title"><span>Job handle</span><span>Inspectable</span></div>
              <div className="result-stack">
                <div className="result-row"><span>Status</span><strong>Succeeded</strong></div>
                <div className="result-row"><span>Progress</span><strong>2 / 2</strong></div>
                <div className="result-row"><span>Attempt</span><strong>1 / 3</strong></div>
                <div className="result-row"><span>Result</span><strong>{`{ delivered: true }`}</strong></div>
              </div>
            </div>
          </div>
        </section>

        <div className="capabilities">
          <section className="section" aria-labelledby="behavior-title">
            <div className="section-heading">
              <div><div className="section-kicker">02 · Queue behavior</div><h2 id="behavior-title">The hard parts have names.</h2></div>
              <p>Enqiu keeps failure behavior visible in code instead of burying it behind a dashboard or a pile of configuration.</p>
            </div>
            <div className="feature-grid">
              <article className="feature-card"><span className="feature-number">01</span><h3>Retry with intent</h3><p>Backoff, attempt limits, timeouts, and expiry are policies on the job—not mysteries in a worker.</p></article>
              <article className="feature-card"><span className="feature-number">02</span><h3>Control live work</h3><p>Pause workers, change concurrency, cancel queued or running jobs, and report structured progress.</p></article>
              <article className="feature-card"><span className="feature-number">03</span><h3>Keep the evidence</h3><p>Inspect lifecycle history, logs, inputs, outputs, and errors through one consistent queue API.</p></article>
            </div>
          </section>
        </div>

        <section className="section" id="drivers" aria-labelledby="drivers-title">
          <div className="section-heading">
            <div><div className="section-kicker">03 · Drivers</div><h2 id="drivers-title">Start local. Add durability without rewriting jobs.</h2></div>
            <p>The memory driver makes tests, scripts, demos, and frontend playgrounds instant. Switch the driver when your process boundary becomes real.</p>
          </div>
          <div className="drivers">
            <article className="driver-card"><div className="mini-label"><Signal /> Zero setup</div><h3>Memory</h3><p>Run the worker in the same browser, Node.js process, or Bun process. Ideal for development and deterministic tests.</p><code>enqiu(handlers)</code></article>
            <div className="driver-arrow" aria-hidden="true">→</div>
            <article className="driver-card"><div className="mini-label"><Signal /> Durable</div><h3>Redis</h3><p>Keep the same typed calls and handler contract while moving queue state to shared infrastructure.</p><code>enqiu(handlers, {`{ driver }`})</code></article>
          </div>
        </section>

        <section className="section contract" id="reliability" aria-labelledby="contract-title">
          <div className="contract-copy"><div className="section-kicker">04 · Reliability contract</div><h2 id="contract-title">Predictable when work gets messy.</h2><p>Queued work is a state machine. Enqiu exposes that state plainly so applications can make honest decisions.</p></div>
          <div className="contract-list">
            <div className="contract-item"><span>01</span><strong>At-least-once delivery</strong><p>Handlers can run again after failures. Use idempotency keys when side effects must be unique.</p></div>
            <div className="contract-item"><span>02</span><strong>Explicit terminal states</strong><p>Succeeded, failed, cancelled, and expired work remain distinguishable and inspectable.</p></div>
            <div className="contract-item"><span>03</span><strong>Abort-aware handlers</strong><p>Cancellation reaches running handlers through an AbortSignal instead of pretending work stopped.</p></div>
            <div className="contract-item"><span>04</span><strong>Typed end to end</strong><p>Handler input and result types flow into producer calls and job handles without manual duplication.</p></div>
          </div>
        </section>

        <section className="final-cta" aria-labelledby="cta-title">
          <h2 id="cta-title">Try it here. Install it anywhere.</h2>
          <div className="final-actions">
            <a className="button" href="/playground">Open the Enqiu playground →</a>
            <CopyCommand final />
          </div>
        </section>
      </main>

      <footer><span>Enqiu · Queues without ceremony.</span><span>MIT licensed · Built for browsers, Node.js, and Bun.</span></footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<LandingApp />);
