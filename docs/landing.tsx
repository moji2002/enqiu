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

const QUICK_START = `import { enqiu } from "enqiu";

const jobs = enqiu({
  sendEmail: async (email, { log }) => {
    log.info("Sending email", { to: email.to });
    return { delivered: true };
  },
});

const delivery = await jobs.sendEmail({ to: "hello@example.com" });
const result = await delivery.result;`;

const CRON = `const schedule = await jobs.sendDigest.schedule({
  id: "weekday-digest",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Nicosia",
  catchUp: true,
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
          <a href="#drivers">drivers</a>
          <a href="#schedules">schedules</a>
          <a href="#limits">limits</a>
          <a href="https://github.com/moji2002/enqiu">github</a>
        </nav>
      </header>

      <main>
        <div className="masthead">
          <h1>A job queue you call like a function.</h1>
          <p className="lede">
            Type-safe background jobs for browsers, Node.js and Bun. Start on the in-memory driver,
            move to Redis without changing your job API.
          </p>
          <p className="sub">
            Define each job once and the name, input and result types are inferred. You keep no
            separate registry, and no hand-written payload types drift out of sync with their
            handlers.
          </p>
          <ul className="spec">
            <li>zero runtime dependencies</li>
            <li>Node.js 20+</li>
            <li>Bun</li>
            <li>browsers</li>
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

        <section aria-labelledby="drivers">
          <h2 id="drivers">Two drivers, one job API</h2>
          <div className="drivers">
            <div className="driver">
              <h3>memory</h3>
              <p>
                Process-local and non-durable. Runs in modern browsers as an in-tab queue — suits
                local-first workflows, client-side processing and tests.
              </p>
            </div>
            <div className="driver">
              <h3>redis</h3>
              <p>
                Atomic Lua transitions, visibility leases and deterministic recovery, so multiple
                Node.js or Bun workers can safely share one queue.
              </p>
            </div>
          </div>
          <p className="note">
            Enqiu never opens connections or pulls in a Redis library — you inject a client you
            already have. It accepts Bun&rsquo;s <code>send(command, args)</code> shape and
            node-redis&rsquo; <code>sendCommand(args)</code> shape, and it does not own that
            client&rsquo;s connection lifecycle.
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
            Five-field cron with IANA time zones. Memory schedules live for the process lifetime;
            Redis schedules are durable and use deterministic occurrence IDs so a run isn&rsquo;t
            duplicated.
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
              The memory driver is process-local and non-durable. Use it for local work, tests, and
              jobs that may disappear with the process.
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
