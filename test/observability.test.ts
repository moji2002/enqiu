import { afterEach, describe, expect, it, vi } from "vitest";
import { enqiu, type Telemetry, type TelemetryEvent } from "../src/index.js";
import { MemoryScheduler } from "../src/memory-scheduler.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close().catch(() => undefined)));
  closers.length = 0;
});

function collector(): { events: TelemetryEvent[]; telemetry: Telemetry } {
  const events: TelemetryEvent[] = [];
  return { events, telemetry: { emit: (event) => events.push(event) } };
}

describe("job context logging", () => {
  it("records every level and surfaces them on the snapshot", async () => {
    const jobs = enqiu({
      work: async (_input: number, context) => {
        context.log.debug("d");
        context.log.info("i", { extra: 1 });
        context.log.warn("w");
        context.log.error("e");
        return 1;
      },
    });
    closers.push(() => jobs.worker.close());

    const handle = await jobs.work(1);
    await handle.result;

    const snapshot = await jobs.queue.get(handle.id);
    expect(snapshot?.logs?.map((entry) => entry.level)).toEqual([
      "debug",
      "info",
      "warn",
      "error",
    ]);
    expect(snapshot?.logs?.[1]?.fields).toEqual({ extra: 1 });
    expect(snapshot?.logs?.[0]?.timestamp).toBeTypeOf("number");
  });

  it("rejects an empty log message", async () => {
    const jobs = enqiu({
      work: async (_input: number, context) => {
        context.log.info("");
        return 1;
      },
    });
    closers.push(() => jobs.worker.close({ drain: false }));

    const handle = await jobs.work(1);
    await expect(handle.result).rejects.toThrow(
      "Job log messages must not be empty"
    );
  });

  it("retains only the most recent entries once logLimit is reached", async () => {
    const jobs = enqiu(
      {
        work: async (_input: number, context) => {
          for (let index = 0; index < 10; index += 1) {
            context.log.info(`entry-${index}`);
          }
          return 1;
        },
      },
      { logLimit: 3 }
    );
    closers.push(() => jobs.worker.close());

    const handle = await jobs.work(1);
    await handle.result;

    const snapshot = await jobs.queue.get(handle.id);
    expect(snapshot?.logs?.map((entry) => entry.message)).toEqual([
      "entry-7",
      "entry-8",
      "entry-9",
    ]);
  });

  it("drops logging entirely when logLimit is zero", async () => {
    const jobs = enqiu(
      {
        work: async (_input: number, context) => {
          context.log.info("ignored");
          return 1;
        },
      },
      { logLimit: 0 }
    );
    closers.push(() => jobs.worker.close());

    const handle = await jobs.work(1);
    await handle.result;
    expect((await jobs.queue.get(handle.id))?.logs).toEqual([]);
  });
});

describe("progress reporting", () => {
  it("accepts a well-formed report and exposes it on the snapshot", async () => {
    const jobs = enqiu({
      work: async (_input: number, context) => {
        await context.reportProgress({
          completed: 1,
          total: 2,
          message: "half",
          details: { stage: "one" },
        });
        return 1;
      },
    });
    closers.push(() => jobs.worker.close());

    const handle = await jobs.work(1);
    await handle.result;
    expect((await jobs.queue.get(handle.id))?.progress).toEqual({
      completed: 1,
      total: 2,
      message: "half",
      details: { stage: "one" },
    });
  });

  it.each([
    ["completed above total", { completed: 3, total: 2 }],
    ["a negative completed", { completed: -1, total: 2 }],
    ["a zero total", { completed: 0, total: 0 }],
    ["a non-finite completed", { completed: Number.NaN, total: 2 }],
    ["a non-finite total", { completed: 1, total: Number.POSITIVE_INFINITY }],
  ])("rejects %s", async (_label, progress) => {
    const jobs = enqiu({
      work: async (_input: number, context) => {
        await context.reportProgress(progress);
        return 1;
      },
    });
    closers.push(() => jobs.worker.close({ drain: false }));

    const handle = await jobs.work(1);
    await expect(handle.result).rejects.toThrow(
      "Progress requires 0 <= completed <= total and total > 0"
    );
  });
});

describe("telemetry", () => {
  it("emits lifecycle, progress and log events", async () => {
    const { events, telemetry } = collector();
    const jobs = enqiu(
      {
        work: async (_input: number, context) => {
          await context.reportProgress({ completed: 1, total: 1 });
          context.log.info("note");
          return 1;
        },
      },
      { name: "tele", telemetry }
    );
    closers.push(() => jobs.worker.close());

    const handle = await jobs.work(1);
    await handle.result;
    await jobs.worker.onIdle();

    const types = events.map((event) => event.type);
    expect(types).toContain("job.added");
    expect(types).toContain("job.started");
    expect(types).toContain("job.succeeded");
    expect(types).toContain("job.progress");
    expect(types).toContain("job.log.info");
    expect(events.every((event) => event.queue === "tele")).toBe(true);
    expect(events[0]?.timestamp).toBeTypeOf("number");
  });

  it("reports a retry and the eventual failure", async () => {
    const { events, telemetry } = collector();
    let attempts = 0;
    const jobs = enqiu(
      {
        work: async () => {
          attempts += 1;
          throw new Error("always");
        },
      },
      { telemetry, retry: { attempts: 2 } }
    );
    closers.push(() => jobs.worker.close({ drain: false }));

    const handle = await jobs.work(undefined as never);
    await handle.result.catch(() => undefined);
    await jobs.worker.onIdle();

    expect(attempts).toBe(2);
    const types = events.map((event) => event.type);
    expect(types).toContain("job.retry");
    expect(types).toContain("job.failed");
  });
});

describe("MemoryScheduler error paths", () => {
  it("refuses to operate on a schedule that does not exist", () => {
    const scheduler = new MemoryScheduler();
    expect(() => scheduler.pause("nope")).toThrow(
      'Schedule "nope" does not exist'
    );
    expect(() => scheduler.resume("nope")).toThrow("does not exist");
    expect(() => scheduler.remove("nope")).toThrow("does not exist");
    expect(scheduler.get("nope")).toBeUndefined();
    scheduler.close();
  });

  it("refuses new registrations once closed, and closing twice is safe", async () => {
    const scheduler = new MemoryScheduler();
    scheduler.close();
    scheduler.close();
    await expect(
      scheduler.upsert({
        jobName: "work",
        cron: "* * * * *",
        input: 1,
        enqueue: async () => undefined,
      })
    ).rejects.toThrow("Scheduler is closed");
  });

  it("will not let a second job take over an existing schedule id", async () => {
    const scheduler = new MemoryScheduler();
    const registration = {
      id: "shared",
      cron: "* * * * *",
      input: 1,
      enqueue: async () => undefined,
    };
    await scheduler.upsert({ ...registration, jobName: "alpha" });
    await expect(
      scheduler.upsert({ ...registration, jobName: "beta" })
    ).rejects.toThrow('Schedule "shared" already belongs to job "alpha"');
    scheduler.close();
  });

  it("keeps advancing after a submission throws", async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new MemoryScheduler();
      let calls = 0;
      const handle = await scheduler.upsert({
        jobName: "work",
        cron: "* * * * *",
        input: 1,
        enqueue: async () => {
          calls += 1;
          throw new Error("submission failed");
        },
      });

      const first = handle.nextRunAt;
      await vi.advanceTimersByTimeAsync(60_000 * 2);
      expect(calls).toBeGreaterThanOrEqual(1);

      // A throwing enqueue must not stop the schedule from moving forward.
      const refreshed = await handle.refresh();
      expect(refreshed.nextRunAt).toBeGreaterThan(first);
      scheduler.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an empty schedule id", async () => {
    const scheduler = new MemoryScheduler();
    await expect(
      scheduler.upsert({
        id: "   ",
        jobName: "",
        cron: "* * * * *",
        input: 1,
        enqueue: async () => undefined,
      })
    ).rejects.toThrow("schedule.id must not be empty");
    scheduler.close();
  });
});
