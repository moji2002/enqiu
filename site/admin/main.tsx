/* eslint-disable @next/next/no-html-link-for-pages -- This is a standalone Vite SPA, not a Next.js route. */

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  enqiu,
  type JobContext,
  type JobSnapshot,
  type JobStatus,
  type QueueStats,
} from "enqiu";
import "./admin.css";

type JobKind = "sendEmail" | "resizeImage" | "syncAccount";
type Filter = "all" | "active" | "succeeded";

const EMPTY_STATS: QueueStats = {
  queued: 0,
  scheduled: 0,
  running: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  expired: 0,
  total: 0,
};

const ACTIVE_STATUSES = new Set<JobStatus>(["queued", "scheduled", "running"]);
const QUEUE_EVENTS = [
  "added",
  "started",
  "progress",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

function delay(duration: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function createAdminQueue() {
  return enqiu(
    {
      sendEmail: async (
        input: { to: string },
        { reportProgress, log, signal }: JobContext,
      ) => {
        log.info("Preparing message", { to: input.to });
        await delay(520, signal);
        await reportProgress({ completed: 1, total: 2, message: "Connected" });
        await delay(720, signal);
        await reportProgress({ completed: 2, total: 2, message: "Accepted" });
        return { delivered: true, to: input.to };
      },
      resizeImage: async (
        input: { file: string; width: number },
        { reportProgress, log, signal }: JobContext,
      ) => {
        log.info("Reading source image", { file: input.file });
        for (const completed of [1, 2, 3]) {
          await delay(460, signal);
          await reportProgress({
            completed,
            total: 3,
            message: completed === 3 ? "Encoded" : "Resizing",
          });
        }
        return { file: input.file, width: input.width, optimized: true };
      },
      syncAccount: async (
        input: { account: string },
        { reportProgress, log, signal }: JobContext,
      ) => {
        log.info("Sync started", { account: input.account });
        await delay(680, signal);
        await reportProgress({ completed: 1, total: 2, message: "Fetched changes" });
        await delay(840, signal);
        await reportProgress({ completed: 2, total: 2, message: "Committed" });
        return { account: input.account, records: 24 };
      },
    },
    {
      name: "browser-admin",
      worker: { concurrency: 2 },
      historyLimit: 50,
    },
  );
}

type AdminQueue = ReturnType<typeof createAdminQueue>;

function progressOf(job: JobSnapshot): number {
  if (job.status === "succeeded") return 100;
  if (!job.progress || typeof job.progress !== "object") return 0;
  const progress = job.progress as { completed?: unknown; total?: unknown };
  const completed = Number(progress.completed ?? 0);
  const total = Number(progress.total ?? 0);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

function statusLabel(status: JobStatus): string {
  if (status === "running") return "Working";
  if (status === "succeeded") return "Complete";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function QueueMark() {
  return (
    <span className="queue-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="metric">
      <span className={`metric-dot ${tone}`} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: JobSnapshot;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const progress = progressOf(job);
  return (
    <li>
      <button
        className="job-row"
        type="button"
        data-selected={selected}
        onClick={() => onSelect(job.id)}
      >
        <span className="job-name-cell">
          <span className={`job-icon ${job.name.slice(0, 1)}`}>{job.name.slice(0, 1)}</span>
          <span>
            <strong>{job.name}()</strong>
            <small>{job.id}</small>
          </span>
        </span>
        <span className={`status-pill ${job.status}`}>{statusLabel(job.status)}</span>
        <span className="progress-cell">
          <span className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </span>
          <small>{progress}%</small>
        </span>
        <time>{formatTime(job.createdAt)}</time>
        <span className="row-arrow" aria-hidden="true">→</span>
      </button>
    </li>
  );
}

function Inspector({ job }: { job: JobSnapshot | undefined }) {
  if (!job) {
    return (
      <aside className="inspector empty-inspector">
        <QueueMark />
        <h2>Select a job</h2>
        <p>Its real input, progress, logs, and result will appear here.</p>
      </aside>
    );
  }

  const progress = progressOf(job);
  return (
    <aside className="inspector">
      <div className="inspector-heading">
        <div>
          <span className="inspector-kicker">Job detail</span>
          <h2>{job.name}()</h2>
        </div>
        <span className={`status-pill ${job.status}`}>{statusLabel(job.status)}</span>
      </div>

      <div className="inspector-progress">
        <span style={{ width: `${progress}%` }} />
      </div>

      <dl className="job-facts">
        <div><dt>Attempt</dt><dd>{job.attempt}</dd></div>
        <div><dt>Priority</dt><dd>{job.priority}</dd></div>
        <div><dt>Created</dt><dd>{formatTime(job.createdAt)}</dd></div>
        <div><dt>Started</dt><dd>{formatTime(job.startedAt)}</dd></div>
      </dl>

      <section className="payload-section">
        <span>Input</span>
        <pre>{JSON.stringify(job.input, null, 2)}</pre>
      </section>

      {job.output !== undefined ? (
        <section className="payload-section success-payload">
          <span>Typed result</span>
          <pre>{JSON.stringify(job.output, null, 2)}</pre>
        </section>
      ) : null}

      <section className="log-section">
        <span>Activity</span>
        <ol>
          {(job.logs ?? []).length > 0 ? (
            job.logs?.map((entry) => (
              <li key={`${entry.timestamp}-${entry.message}`}>
                <i aria-hidden="true" />
                <span>{entry.message}</span>
                <time>{formatTime(entry.timestamp)}</time>
              </li>
            ))
          ) : (
            <li className="empty-log">Waiting for handler activity</li>
          )}
        </ol>
      </section>
    </aside>
  );
}

function AdminApp() {
  const [jobs] = useState<AdminQueue>(createAdminQueue);
  const [items, setItems] = useState<JobSnapshot[]>([]);
  const [stats, setStats] = useState<QueueStats>(EMPTY_STATS);
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [paused, setPaused] = useState(false);
  const [concurrency, setConcurrency] = useState(2);
  const [error, setError] = useState<string>();
  const refreshVersion = useRef(0);
  const enqueueSequence = useRef(0);
  const seeded = useRef(false);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [page, nextStats] = await Promise.all([
      jobs.queue.list({ limit: 50 }),
      jobs.queue.stats(),
    ]);
    if (version !== refreshVersion.current) return;

    const nextItems = [...page.jobs].reverse() as JobSnapshot[];
    startTransition(() => {
      setItems(nextItems);
      setStats(nextStats);
      setSelectedId((current) =>
        current && nextItems.some((job) => job.id === current)
          ? current
          : nextItems[0]?.id,
      );
    });
  }, [jobs]);

  const enqueue = useCallback(
    async (kind: JobKind) => {
      try {
        setError(undefined);
        const sequence = Date.now() + ++enqueueSequence.current;
        const handle =
          kind === "sendEmail"
            ? await jobs.sendEmail({ to: `person${sequence % 97}@example.com` })
            : kind === "resizeImage"
              ? await jobs.resizeImage({ file: `hero-${sequence % 12}.png`, width: 1440 })
              : await jobs.syncAccount({ account: `acct_${(sequence % 900) + 100}` });
        setSelectedId(handle.id);
        void handle.result.catch(() => undefined);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not enqueue job");
      }
    },
    [jobs, refresh],
  );

  useEffect(() => {
    const unsubscribers = QUEUE_EVENTS.map((event) =>
      jobs.queue.on(event, () => void refresh()),
    );
    void refresh();

    if (!seeded.current) {
      seeded.current = true;
      void Promise.all([
        enqueue("sendEmail"),
        enqueue("resizeImage"),
        enqueue("syncAccount"),
      ]);
    }

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void jobs.worker.close({ drain: false });
    };
  }, [enqueue, jobs, refresh]);

  const visibleItems = useMemo(() => {
    if (filter === "active") {
      return items.filter((job) => ACTIVE_STATUSES.has(job.status));
    }
    if (filter === "succeeded") {
      return items.filter((job) => job.status === "succeeded");
    }
    return items;
  }, [filter, items]);

  const selectedJob = items.find((job) => job.id === selectedId);

  const toggleWorker = async () => {
    if (paused) {
      await jobs.worker.resume();
    } else {
      await jobs.worker.pause();
    }
    setPaused((current) => !current);
    await refresh();
  };

  const changeConcurrency = async (value: number) => {
    await jobs.queue.setConcurrency(value);
    setConcurrency(value);
    await refresh();
  };

  const clearFinished = async () => {
    await jobs.queue.cleanup({
      status: ["succeeded", "failed", "cancelled", "expired"],
      limit: 50,
    });
    await refresh();
  };

  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <a className="admin-brand" href="/" aria-label="Back to Enqiu home">
          enqiu<span>.</span>
        </a>
        <div className="nav-context">
          <span>Workspace</span>
          <strong><QueueMark /> Browser lab</strong>
        </div>
        <nav aria-label="Admin navigation">
          <a className="active" href="#jobs"><span>⌁</span> Jobs</a>
          <a href="#worker"><span>↯</span> Worker</a>
          <a href="/#quick-start"><span>⌘</span> Docs</a>
        </nav>
        <div className="runtime-card-admin">
          <span className="live-dot" aria-hidden="true" />
          <div>
            <strong>Memory driver</strong>
            <small>Running in this tab</small>
          </div>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-header">
          <div>
            <span className="page-kicker">React admin · real Enqiu state</span>
            <h1>Job queue</h1>
          </div>
          <div className="header-actions">
            <button className="worker-toggle" type="button" onClick={() => void toggleWorker()}>
              <span className={paused ? "paused" : "running"} aria-hidden="true" />
              {paused ? "Resume worker" : "Pause worker"}
            </button>
            <div className="enqueue-menu">
              <button type="button" onClick={() => void enqueue("sendEmail")}>+ Email</button>
              <button type="button" onClick={() => void enqueue("resizeImage")}>+ Image</button>
              <button type="button" onClick={() => void enqueue("syncAccount")}>+ Sync</button>
            </div>
          </div>
        </header>

        <section className="metric-strip" aria-label="Live queue statistics" aria-live="polite">
          <Metric label="Waiting" value={stats.queued + stats.scheduled} tone="cobalt" />
          <Metric label="Working" value={stats.running} tone="coral" />
          <Metric label="Complete" value={stats.succeeded} tone="mint" />
          <Metric label="Total" value={stats.total} tone="ink" />
          <div className="concurrency-control" id="worker">
            <span>Concurrency</span>
            {[1, 2, 4].map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={concurrency === value}
                onClick={() => void changeConcurrency(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </section>

        {error ? <p className="admin-error" role="alert">{error}</p> : null}

        <div className="admin-workspace" id="jobs">
          <section className="jobs-panel" aria-labelledby="jobs-heading">
            <div className="panel-toolbar">
              <div>
                <h2 id="jobs-heading">Recent jobs</h2>
                <span>{visibleItems.length} shown</span>
              </div>
              <div className="filter-group" aria-label="Filter jobs">
                {(["all", "active", "succeeded"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value === "succeeded" ? "Complete" : value}
                  </button>
                ))}
                <button className="clear-button" type="button" onClick={() => void clearFinished()}>
                  Clear done
                </button>
              </div>
            </div>

            <div className="job-columns" aria-hidden="true">
              <span>Job</span><span>Status</span><span>Progress</span><span>Created</span><span />
            </div>
            {visibleItems.length > 0 ? (
              <ul className="job-list">
                {visibleItems.map((job) => (
                  <JobRow
                    key={job.id}
                    job={job}
                    selected={job.id === selectedId}
                    onSelect={setSelectedId}
                  />
                ))}
              </ul>
            ) : (
              <div className="empty-list">
                <QueueMark />
                <strong>No jobs in this view</strong>
                <span>Enqueue one above or choose another filter.</span>
              </div>
            )}
          </section>

          <Inspector job={selectedJob} />
        </div>
      </main>
    </div>
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("Admin root element is missing");
createRoot(root).render(<AdminApp />);
