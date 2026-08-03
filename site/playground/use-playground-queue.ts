import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  JobHandle,
  JobSnapshot,
  JobStatus,
  QueueStats,
} from "enqiu";
import {
  createPlaygroundQueue,
  defaultDraft,
  submitDraft,
  type PlaygroundQueue,
} from "./queue";
import type {
  ComposerDraft,
  Concurrency,
  PlaygroundActions,
  PlaygroundState,
  RecipeId,
} from "./types";

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

const QUEUE_EVENTS = [
  "added",
  "started",
  "progress",
  "log",
  "retry",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

const CANCELLABLE = new Set<JobStatus>(["queued", "scheduled", "running"]);
const REDRIVABLE = new Set<JobStatus>(["failed", "cancelled", "expired"]);

function initialState(): PlaygroundState {
  return {
    jobs: [],
    stats: EMPTY_STATS,
    paused: false,
    concurrency: 2,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The playground action failed.";
}

function recipeId(name: string): RecipeId | undefined {
  return name === "sendEmail" || name === "resizeImage" || name === "syncAccount"
    ? name
    : undefined;
}

function priorityName(priority: number): ComposerDraft["priority"] {
  if (priority > 0) return "high";
  if (priority < 0) return "low";
  return "normal";
}

function delayValue(job: JobSnapshot): ComposerDraft["delayMs"] {
  const duration = Math.max(0, job.runAt - job.createdAt);
  if (duration >= 4_000) return 5_000;
  if (duration >= 1_000) return 2_000;
  return 0;
}

function draftFromJob(job: JobSnapshot): ComposerDraft | undefined {
  const recipe = recipeId(job.name);
  if (!recipe) return undefined;
  const input =
    job.input && typeof job.input === "object" && !Array.isArray(job.input)
      ? { ...(job.input as Record<string, unknown>) }
      : {};
  const failOnce = input.failOnce === true;
  delete input.failOnce;
  return {
    ...defaultDraft(recipe),
    payload: JSON.stringify(input, null, 2),
    priority: priorityName(job.priority),
    delayMs: delayValue(job),
    retryAttempts: Math.min(3, Math.max(1, job.retries + 1)) as 1 | 2 | 3,
    failOnce,
  };
}

export function usePlaygroundQueue(): readonly [
  PlaygroundState,
  PlaygroundActions,
] {
  const [queue, setQueue] = useState<PlaygroundQueue>(createPlaygroundQueue);
  const [state, setState] = useState<PlaygroundState>(initialState);
  const handles = useRef(new Map<string, JobHandle>());
  const selectedId = useRef<string | undefined>(undefined);
  const refreshVersion = useRef(0);
  const refreshScheduled = useRef(false);

  const select = useCallback((id: string) => {
    selectedId.current = id;
    setState((current) => ({ ...current, selectedId: id }));
  }, []);

  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [page, stats] = await Promise.all([
      queue.queue.list({ limit: 80 }),
      queue.queue.stats(),
    ]);
    if (version !== refreshVersion.current) return;
    const jobs = [...page.jobs].reverse() as JobSnapshot[];
    const currentSelection = selectedId.current;
    const nextSelection =
      currentSelection && jobs.some((job) => job.id === currentSelection)
        ? currentSelection
        : jobs[0]?.id;
    selectedId.current = nextSelection;
    startTransition(() => {
      setState((current) => ({
        ...current,
        jobs,
        stats,
        selectedId: nextSelection,
      }));
    });
  }, [queue]);

  const scheduleRefresh = useCallback(() => {
    if (refreshScheduled.current) return;
    refreshScheduled.current = true;
    void Promise.resolve().then(async () => {
      refreshScheduled.current = false;
      await refresh();
    });
  }, [refresh]);

  useEffect(() => {
    const unsubscribers = QUEUE_EVENTS.map((event) =>
      queue.queue.on(event, scheduleRefresh),
    );
    void refresh();
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      void queue.worker.close({ drain: false });
    };
  }, [queue, refresh, scheduleRefresh]);

  const runAction = useCallback(
    async (name: string, action: () => Promise<void>) => {
      setState((current) => ({
        ...current,
        busyAction: name,
        alert: undefined,
      }));
      try {
        await action();
      } catch (error) {
        setState((current) => ({
          ...current,
          alert: errorMessage(error),
        }));
        throw error;
      } finally {
        setState((current) => ({
          ...current,
          busyAction: current.busyAction === name ? undefined : current.busyAction,
        }));
      }
    },
    [],
  );

  const enqueue = useCallback(
    async (draft: ComposerDraft) => {
      await runAction("enqueue", async () => {
        const { handle } = await submitDraft(queue, draft);
        handles.current.set(handle.id, handle);
        select(handle.id);
        setState((current) => ({
          ...current,
          alert: `${handle.name} accepted as ${handle.id}.`,
        }));
        await refresh();
      });
    },
    [queue, refresh, runAction, select],
  );

  const enqueueScenario = useCallback(
    async (
      kind: "queue-three" | "fail-once" | "schedule-five",
      draft: ComposerDraft,
    ) => {
      await runAction(kind, async () => {
        const drafts: ComposerDraft[] =
          kind === "queue-three"
            ? ["low", "normal", "high"].map((priority) => ({
                ...draft,
                priority: priority as ComposerDraft["priority"],
                customId: undefined,
                idempotencyKey: undefined,
              }))
            : kind === "fail-once"
              ? [{
                  ...defaultDraft("syncAccount"),
                  failOnce: true,
                  retryAttempts: 2,
                }]
              : [{ ...draft, delayMs: 5_000, customId: undefined }];
        const submissions = [];
        for (const nextDraft of drafts) {
          submissions.push(await submitDraft(queue, nextDraft));
        }
        submissions.forEach(({ handle }) => handles.current.set(handle.id, handle));
        const last = submissions.at(-1)?.handle;
        if (last) select(last.id);
        setState((current) => ({
          ...current,
          alert:
            kind === "queue-three"
              ? "Three real jobs entered the queue."
              : kind === "fail-once"
                ? "A retry scenario entered the queue."
                : "A job is scheduled for five seconds from now.",
        }));
        await refresh();
      });
    },
    [queue, refresh, runAction, select],
  );

  const setPaused = useCallback(
    async (paused: boolean) => {
      await runAction(paused ? "pause" : "resume", async () => {
        if (paused) await queue.worker.pause();
        else await queue.worker.resume();
        setState((current) => ({ ...current, paused }));
        await refresh();
      });
    },
    [queue, refresh, runAction],
  );

  const setConcurrency = useCallback(
    async (concurrency: Concurrency) => {
      await runAction("concurrency", async () => {
        await queue.queue.setConcurrency(concurrency);
        setState((current) => ({ ...current, concurrency }));
        await refresh();
      });
    },
    [queue, refresh, runAction],
  );

  const cancelSelected = useCallback(async () => {
    const id = selectedId.current;
    if (!id) return;
    await runAction("cancel", async () => {
      const snapshot = await queue.queue.get(id);
      if (!snapshot || !CANCELLABLE.has(snapshot.status)) {
        throw new Error("Only queued, scheduled, or running jobs can be cancelled.");
      }
      const handle = handles.current.get(id);
      if (!handle) throw new Error("This job no longer has a cancellable handle.");
      await handle.cancel("Cancelled in the playground");
      await refresh();
    });
  }, [queue, refresh, runAction]);

  const redriveSelected = useCallback(async () => {
    const id = selectedId.current;
    if (!id) return;
    await runAction("redrive", async () => {
      const snapshot = await queue.queue.get(id);
      if (!snapshot || !REDRIVABLE.has(snapshot.status)) {
        throw new Error("Only failed, cancelled, or expired jobs can be redriven.");
      }
      const handle = await queue.queue.redrive(id);
      handles.current.set(handle.id, handle);
      select(handle.id);
      void handle.result.catch(() => undefined);
      await refresh();
    });
  }, [queue, refresh, runAction, select]);

  const draftFromSelected = useCallback(() => {
    const job = state.jobs.find((item) => item.id === selectedId.current);
    return job ? draftFromJob(job) : undefined;
  }, [state.jobs]);

  const cleanup = useCallback(
    async (scope: "succeeded" | "terminal") => {
      await runAction("cleanup", async () => {
        await queue.queue.cleanup({
          status:
            scope === "succeeded"
              ? "succeeded"
              : ["succeeded", "failed", "cancelled", "expired"],
          limit: 80,
        });
        await refresh();
      });
    },
    [queue, refresh, runAction],
  );

  const reset = useCallback(async () => {
    await runAction("reset", async () => {
      await queue.worker.close({ drain: false });
      handles.current.clear();
      selectedId.current = undefined;
      setState(initialState());
      setQueue(createPlaygroundQueue());
    });
  }, [queue, runAction]);

  const clearAlert = useCallback(() => {
    setState((current) => ({ ...current, alert: undefined }));
  }, []);

  const actions = useMemo<PlaygroundActions>(
    () => ({
      enqueue,
      enqueueScenario,
      select,
      setPaused,
      setConcurrency,
      cancelSelected,
      redriveSelected,
      draftFromSelected,
      cleanup,
      reset,
      clearAlert,
    }),
    [
      cancelSelected,
      cleanup,
      clearAlert,
      draftFromSelected,
      enqueue,
      enqueueScenario,
      redriveSelected,
      reset,
      select,
      setConcurrency,
      setPaused,
    ],
  );

  return [state, actions] as const;
}
