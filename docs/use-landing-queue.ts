import { useCallback, useEffect, useRef, useState } from "react";
import { enqiu, type JobHandle, type JobSnapshot } from "enqiu";

export type PreviewPhase = "queued" | "working" | "complete" | "failed";

export interface LandingQueueState {
  phase: PreviewPhase;
  status: string;
  result: string;
  progress: number;
  running: boolean;
}

const INITIAL_STATE: LandingQueueState = {
  phase: "queued",
  status: "Ready to run",
  result: "Powered by the real Enqiu memory driver",
  progress: 0,
  running: false,
};

function wait(duration: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createLandingQueue() {
  return enqiu(
    {
      sendEmail: async ({ to }: { to: string }, context) => {
        const immediate = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        await wait(immediate ? 0 : 480, context.signal);
        await context.reportProgress({
          completed: 1,
          total: 2,
          message: "Connected to mail provider",
        });
        await wait(immediate ? 0 : 620, context.signal);
        await context.reportProgress({
          completed: 2,
          total: 2,
          message: "Message accepted",
        });
        await wait(immediate ? 0 : 320, context.signal);
        return {
          delivered: true,
          id: context.id.split(":").at(-1),
          to,
        };
      },
    },
    {
      name: "landing",
      worker: false,
      historyLimit: 8,
    },
  );
}

type LandingQueue = ReturnType<typeof createLandingQueue>;

function progressPercent(job: JobSnapshot): number {
  if (!job.progress || typeof job.progress !== "object") return 0;
  const progress = job.progress as { completed?: unknown; total?: unknown };
  const completed = Number(progress.completed ?? 0);
  const total = Math.max(1, Number(progress.total ?? 1));
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

export function useLandingQueue(): readonly [
  LandingQueueState,
  { run(): Promise<void>; reset(): Promise<void> },
] {
  const [queue] = useState<LandingQueue>(createLandingQueue);
  const [state, setState] = useState<LandingQueueState>(INITIAL_STATE);
  const activeId = useRef<string | undefined>(undefined);
  const activeHandle = useRef<JobHandle | undefined>(undefined);
  const sequence = useRef(0);

  useEffect(() => {
    const isActive = (job: JobSnapshot) => job.id === activeId.current;
    const unsubscribers = [
      queue.queue.on("added", (job) => {
        if (!isActive(job)) return;
        setState({
          phase: "queued",
          status: "Accepted by Enqiu",
          result: `Job ${job.id} is queued`,
          progress: 12,
          running: true,
        });
      }),
      queue.queue.on("started", (job) => {
        if (!isActive(job)) return;
        setState({
          phase: "working",
          status: `Running attempt ${job.attempt}`,
          result: "Handler started",
          progress: 28,
          running: true,
        });
      }),
      queue.queue.on("progress", (job) => {
        if (!isActive(job)) return;
        const progress = job.progress as { completed?: unknown; total?: unknown; message?: unknown } | undefined;
        const completed = Number(progress?.completed ?? 0);
        const total = Math.max(1, Number(progress?.total ?? 1));
        setState({
          phase: "working",
          status: typeof progress?.message === "string" ? progress.message : "Handler is working",
          result: `${completed} of ${total} steps complete`,
          progress: progressPercent(job),
          running: true,
        });
      }),
      queue.queue.on("succeeded", (job) => {
        if (!isActive(job)) return;
        const duration = Math.max(1, (job.finishedAt ?? Date.now()) - (job.startedAt ?? Date.now()));
        setState({
          phase: "complete",
          status: `Succeeded in ${duration}ms`,
          result: JSON.stringify(job.output),
          progress: 100,
          running: false,
        });
      }),
      queue.queue.on("failed", (job) => {
        if (!isActive(job)) return;
        setState({
          phase: "failed",
          status: "Handler failed",
          result: job.error?.message ?? "Job failed",
          progress: 0,
          running: false,
        });
      }),
      queue.queue.on("cancelled", (job) => {
        if (!isActive(job)) return;
        setState({ ...INITIAL_STATE, status: "Run cancelled" });
      }),
    ];

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void queue.worker.close({ drain: false });
    };
  }, [queue]);

  const reset = useCallback(async () => {
    sequence.current += 1;
    if (activeHandle.current) {
      await activeHandle.current.cancel("Landing preview reset");
    }
    await queue.worker.pause();
    activeHandle.current = undefined;
    activeId.current = undefined;
    setState(INITIAL_STATE);
  }, [queue]);

  const run = useCallback(async () => {
    const currentRun = ++sequence.current;
    if (activeHandle.current) {
      await activeHandle.current.cancel("Replaced by a new landing preview run");
    }
    if (currentRun !== sequence.current) return;

    await queue.worker.pause();
    const id = `landing:sendEmail:${Date.now().toString(36)}-${currentRun}`;
    activeId.current = id;
    setState({
      phase: "queued",
      status: "Queueing…",
      result: "Creating a real in-browser job",
      progress: 8,
      running: true,
    });

    const handle = await queue.sendEmail({ to: "you@example.com" }, { id });
    activeHandle.current = handle;
    await wait(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420);
    if (currentRun !== sequence.current) return;
    await queue.worker.start();

    try {
      await handle.result;
    } catch (error) {
      if (currentRun === sequence.current && handle.status !== "cancelled") {
        setState({
          phase: "failed",
          status: "Could not run the job",
          result: error instanceof Error ? error.message : "Unknown queue error",
          progress: 0,
          running: false,
        });
      }
    } finally {
      if (currentRun === sequence.current) await queue.worker.pause();
    }
  }, [queue]);

  return [state, { run, reset }] as const;
}
