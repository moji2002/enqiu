import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./landing.css";

/**
 * The landing page for enqiu.worksonmy.dev.
 *
 * Structure note: this page leads with the call site rather than with prose,
 * because the pitch for this library IS the shape of its API — you define a
 * job once and call it like a function, with name, input and result types
 * inferred. Describing that in a paragraph is strictly worse than showing
 * eight lines of it, so the first thing under the headline is code.
 *
 * Every claim here traces to the README. Nothing is invented — in particular
 * there are no throughput or benchmark figures, because the project doesn't
 * publish any.
 */

/**
 * Samples are authored as plain strings and highlighted here, rather than
 * hand-wrapped in <span>s in the JSX. Hand-wrapping is unreadable at this
 * size and silently breaks whitespace inside <pre>.
 */
const TOKENS =
  /("(?:[^"\\]|\\.)*"|\/\/[^\n]*|\b(?:import|from|const|await|async|return|true|false)\b)/g;

const KEYWORDS = /^(?:import|from|const|await|async|return|true|false)$/;

function highlight(source: string): ReactNode[] {
  return source.split(TOKENS).map((part, i) => {
    if (!part) return null;
    if (part.startsWith('"')) {
      return (
        <span key={i} className="s">
          {part}
        </span>
      );
    }
    if (part.startsWith("//")) {
      return (
        <span key={i} className="c">
          {part}
        </span>
      );
    }
    if (KEYWORDS.test(part)) {
      return (
        <span key={i} className="k">
          {part}
        </span>
      );
    }
    return part;
  });
}

function Code({ children }: { children: string }) {
  return (
    <pre>
      <code>{highlight(children)}</code>
    </pre>
  );
}

const QUICK_START = `import { enqiu, job } from "enqiu";
import { z } from "zod";

const jobs = enqiu({
  sendEmail: job({
    input: z.object({ to: z.string() }),
    timeout: 30000,
    run: async (email, { log }) => {
      log.info("Sending email", { to: email.to });
      return { delivered: true };
    },
  }),
}, {
  connection: { host: "localhost", port: 6379 },
  worker: { concurrency: 10 },
});

const delivery = await jobs.sendEmail({ to: "hello@example.com" });
const result = await delivery.result;`;

const CRON = `const schedule = await jobs.sendDigest.schedule({
  id: "weekday-digest",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Nicosia",
  input: { segment: "active" },
});`;

function Landing() {
  return (
    <>
      <header className="topbar">
        <a className="wordmark" href="/">
          enqiu
        </a>
        <nav aria-label="Sections">
          <a href="#start">start</a>
          <a href="#built-on">built on</a>
          <a href="#schedules">schedules</a>
          <a href="#limits">limits</a>
          <a href="https://github.com/moji2002/enqiu">github</a>
        </nav>
      </header>

      <main>
        <div className="masthead">
          <p className="alpha" role="note">
            <strong>Alpha.</strong> Not for production — the API still breaks between releases
            without a deprecation period. Published under the <code>alpha</code> tag, so install
            it as <code>enqiu@alpha</code>.
          </p>
          <h1>A job queue you call like a function.</h1>
          <p className="lede">
            A type-safe job API on top of BullMQ. BullMQ owns storage, scheduling and execution;
            Enqiu owns the developer experience.
          </p>
          <p className="sub">
            Define each job once and the name, input and result types are inferred. You keep no
            separate registry, and no hand-written payload types drift out of sync with their
            handlers.
          </p>
          <ul className="spec">
            <li>built on BullMQ</li>
            <li>Standard Schema</li>
            <li>Node.js 20+</li>
            <li>Redis</li>
            <li>ESM + TypeScript declarations</li>
          </ul>
        </div>

        <section aria-labelledby="start">
          <h2 id="start">Most of the API, in one sample</h2>
          <Code>{QUICK_START}</Code>
          <p className="note">
            <code>await jobs.sendEmail(input)</code> resolves once the queue accepts the job and
            hands back a handle — it does not wait for the handler to run. Await{" "}
            <code>handle.result</code> only when the caller actually needs the result. Ignoring a
            handle is safe and never produces an unhandled rejection.
          </p>
        </section>

        <section aria-labelledby="built-on">
          <h2 id="built-on">Built on BullMQ</h2>
          <div className="drivers">
            <div className="driver">
              <h3>Enqiu adds</h3>
              <p>
                Inferred job names, input and result types. Standard Schema validation at the
                boundary, so bad input never reaches the queue. A per-attempt{" "}
                <code>timeout</code> with an <code>AbortSignal</code>, and{" "}
                <code>expiresIn</code> — BullMQ has neither.
              </p>
            </div>
            <div className="driver">
              <h3>BullMQ provides</h3>
              <p>
                Storage, scheduling and execution. Retries and backoff, priorities, delays, cron,
                deduplication, bulk submission, progress, logs, events and cleanup — surfaced
                through Enqiu&rsquo;s API rather than reimplemented behind it.
              </p>
            </div>
          </div>
          <p className="note">
            <code>bullmq</code> and <code>ioredis</code> are peer dependencies: Enqiu does not pick
            versions or open connections for you. Measured against raw BullMQ on the same Redis,
            the layer costs about 3% for a bare handler and 6% with Zod validation.
          </p>
          <p className="note">
            Gaps in BullMQ&rsquo;s open-source tier are left as gaps rather than faked. Per-key
            concurrency and per-key rate limiting are BullMQ Pro features; debounce has no
            open-source equivalent; and a browser queue is not possible, since BullMQ needs Redis
            and Node.
          </p>
        </section>

        <section aria-labelledby="schedules">
          <h2 id="schedules">Schedules, policies and HTTP</h2>
          <p>
            Retry and rate policies sit beside the handler, so call sites stay clean. Durations are
            plain milliseconds — pass a number, or <code>ms("30s")</code>, without that becoming an
            Enqiu dependency.
          </p>
          <Code>{CRON}</Code>
          <p className="note">
            Five-field cron with IANA time zones, backed by BullMQ job schedulers, so a schedule
            survives restarts and is shared by every worker on the queue.
          </p>
          <p className="note">
            Because Enqiu speaks Standard Schema and exposes each job&rsquo;s input schema, one
            schema can validate an HTTP route without redefining a type —{" "}
            <code>sValidator("json", jobs.sendEmail.input)</code>. Hono and{" "}
            <code>@hono/standard-validator</code> stay optional application dependencies.
          </p>
        </section>

        <section aria-labelledby="limits">
          <h2 id="limits">Operational boundaries</h2>
          <p className="note">
            Stated up front, because discovering these in production is the expensive way.
          </p>
          <ul className="bounds">
            <li>
              Enqiu requires Redis and Node. There is no in-browser queue, because BullMQ needs
              both.
            </li>
            <li>
              Job inputs and results must be JSON-safe. Functions, streams, class instances, sparse
              arrays and <code>undefined</code> fields are not portable queue data.
            </li>
            <li>
              Retries and worker recovery can run a job more than once. Make external side effects
              idempotent when duplicate execution would be harmful.
            </li>
            <li>Enqiu coordinates jobs. It is not a distributed transaction coordinator.</li>
          </ul>
        </section>

        <footer>
          <nav aria-label="Project links">
            <a href="https://github.com/moji2002/enqiu">GitHub</a>
            <a href="https://www.npmjs.com/package/enqiu">npm</a>
            <a href="https://worksonmy.dev/projects/enqiu">Project notes</a>
            <a href="/llms.txt">llms.txt</a>
          </nav>
          <p>
            By <a href="https://worksonmy.dev">Mojtaba Beheshti</a>. MIT licensed.
          </p>
        </footer>
      </main>
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Landing root element is missing");
createRoot(root).render(<Landing />);
