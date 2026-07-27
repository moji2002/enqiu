import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  JobCancelledError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
  memoryQueue,
} from "../src/memory.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("memoryQueue", () => {
  it("infers each named job's input and output", async () => {
    const queue = memoryQueue({
      email: async (input: { to: string }) => input.to.length,
      invoice: async (input: { amount: number }) => input.amount > 0,
    });

    const email = queue.add("email", { to: "hello@example.com" });
    const invoice = queue.add("invoice", { amount: 42 });

    expectTypeOf(email.input).toEqualTypeOf<{ to: string }>();
    expectTypeOf(await email).toEqualTypeOf<number>();
    expectTypeOf(await invoice).toEqualTypeOf<boolean>();
    expect(await email).toBe(17);
    expect(await invoice).toBe(true);
  });

  it("runs jobs in the background and exposes an awaitable handle", async () => {
    const queue = memoryQueue({
      double: async (value: number) => value * 2,
    });

    const job = queue.add("double", 21);

    expect(job.id).toContain("default:double:");
    expect(["queued", "running", "succeeded"]).toContain(job.status);
    expect(await job).toBe(42);
    expect(job.status).toBe("succeeded");
    expect(job.snapshot().output).toBe(42);
  });

  it("never exceeds the configured concurrency", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;

    const queue = memoryQueue(
      {
        work: async (value: number) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
          return value;
        },
      },
      { concurrency: 2 }
    );

    const jobs = queue.addMany("work", [1, 2, 3, 4]);
    await flushMicrotasks();

    expect(queue.pending).toBe(2);
    expect(queue.size).toBe(2);
    expect(maxActive).toBe(2);

    while (releases.length > 0) {
      releases.shift()?.();
      await flushMicrotasks();
    }
    while (queue.pending > 0 || queue.size > 0) {
      releases.shift()?.();
      await flushMicrotasks();
    }

    expect(await Promise.all(jobs)).toEqual([1, 2, 3, 4]);
    expect(maxActive).toBe(2);
  });

  it("orders queued work by priority and keeps equal priorities FIFO", async () => {
    const order: string[] = [];
    const queue = memoryQueue(
      {
        record: async (value: string) => {
          order.push(value);
        },
      },
      { autoStart: false, concurrency: 1 }
    );

    queue.add("record", "low", { priority: -1 });
    queue.add("record", "high-1", { priority: 10 });
    queue.add("record", "normal", { priority: 0 });
    queue.add("record", "high-2", { priority: 10 });

    queue.start();
    await queue.onIdle();

    expect(order).toEqual(["high-1", "high-2", "normal", "low"]);
  });

  it("supports millisecond and exact-date scheduling", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const queue = memoryQueue({
      run: async (value: string) => {
        calls.push(value);
      },
    });

    const first = queue.add("run", "delay", { delay: 100 });
    const second = queue.add("run", "date", {
      delay: new Date(Date.now() + 200),
    });
    await flushMicrotasks();

    expect(first.status).toBe("scheduled");
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["delay"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["delay", "date"]);

    await Promise.all([first, second]);
  });

  it("retries with backoff and reports one-based attempts", async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const queue = memoryQueue({
      flaky: async (_: undefined, context) => {
        attempts.push(context.attempt);
        if (context.attempt < 3) {
          throw new Error("temporary");
        }
        return "ok";
      },
    });

    const job = queue.add("flaky", undefined, {
      retry: {
        retries: 2,
        backoff: { type: "exponential", delay: 10 },
      },
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);

    expect(await job).toBe("ok");
    expect(attempts).toEqual([1, 2, 3]);
    expect(job.snapshot().attempt).toBe(3);
  });

  it("can decline a retry based on the error", async () => {
    const queue = memoryQueue({
      fail: async () => {
        throw new TypeError("invalid input");
      },
    });

    const job = queue.add("fail", undefined, {
      retry: {
        retries: 5,
        when: (error) => !(error instanceof TypeError),
      },
    });

    await expect(job.result).rejects.toBeInstanceOf(JobFailedError);
    expect(job.snapshot().attempt).toBe(1);
  });

  it("times out an attempt and aborts its signal", async () => {
    vi.useFakeTimers();
    let receivedReason: unknown;
    const queue = memoryQueue({
      slow: async (_: undefined, { signal }) =>
        new Promise<void>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              receivedReason = signal.reason;
              reject(signal.reason);
            },
            { once: true }
          );
        }),
    });

    const job = queue.add("slow", undefined, { timeout: 50 });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(50);

    await expect(job.result).rejects.toBeInstanceOf(JobFailedError);
    expect(receivedReason).toBeInstanceOf(JobTimeoutError);
    expect(job.status).toBe("failed");
  });

  it("cancels queued jobs through either the handle or an AbortSignal", async () => {
    const controller = new AbortController();
    const queue = memoryQueue(
      { work: async (value: number) => value },
      { autoStart: false }
    );

    const byHandle = queue.add("work", 1);
    const bySignal = queue.add("work", 2, { signal: controller.signal });

    expect(byHandle.cancel("not needed")).toBe(true);
    controller.abort("superseded");

    await expect(byHandle.result).rejects.toBeInstanceOf(JobCancelledError);
    await expect(bySignal.result).rejects.toBeInstanceOf(JobCancelledError);
    expect(byHandle.status).toBe("cancelled");
    expect(bySignal.snapshot().error?.message).toBe("superseded");
  });

  it("deduplicates unfinished work by name and key", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const queue = memoryQueue({
      sync: async (value: number) => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return value;
      },
    });

    const first = queue.add("sync", 1, { key: "account-1" });
    const duplicate = queue.add("sync", 999, { key: "account-1" });
    await flushMicrotasks();

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.input).toBe(1);
    expect(duplicate.deduplicated).toBe(true);
    expect(calls).toBe(1);

    release?.();
    expect(await duplicate).toBe(1);

    const next = queue.add("sync", 2, { key: "account-1" });
    expect(next.id).not.toBe(first.id);
    next.cancel();
  });

  it("enforces a strict rolling-window rate limit", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const queue = memoryQueue(
      {
        request: async (value: number) => {
          starts.push(Date.now());
          return value;
        },
      },
      {
        concurrency: 10,
        rateLimit: { limit: 2, interval: 100 },
      }
    );

    const jobs = queue.addMany("request", [1, 2, 3]);
    await flushMicrotasks();

    expect(starts).toHaveLength(2);
    expect(queue.isRateLimited).toBe(true);

    await vi.advanceTimersByTimeAsync(99);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(3);
    expect(await Promise.all(jobs)).toEqual([1, 2, 3]);
  });

  it("reports progress and lifecycle events without observer failures breaking work", async () => {
    const events: string[] = [];
    const queue = memoryQueue({
      import: async (_: undefined, job) => {
        job.progress(0.5);
        job.progress(1);
        return "done";
      },
    });

    queue.on("started", () => events.push("started"));
    queue.on("progress", (job) => events.push(`progress:${job.progress}`));
    queue.on("progress", () => {
      throw new Error("observer bug");
    });
    queue.on("succeeded", () => events.push("succeeded"));
    queue.on("idle", () => events.push("idle"));

    expect(await queue.add("import", undefined)).toBe("done");
    await queue.onIdle();
    expect(events).toEqual([
      "started",
      "progress:0.5",
      "progress:1",
      "succeeded",
      "idle",
    ]);
  });

  it("supports producer backpressure", async () => {
    let release: (() => void) | undefined;
    const queue = memoryQueue(
      {
        work: async () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
      { concurrency: 1 }
    );

    queue.add("work", undefined);
    queue.add("work", undefined);
    queue.add("work", undefined);
    await flushMicrotasks();

    let capacityAvailable = false;
    const capacity = queue.onSizeLessThan(2).then(() => {
      capacityAvailable = true;
    });
    await flushMicrotasks();
    expect(capacityAvailable).toBe(false);

    release?.();
    await flushMicrotasks();
    await capacity;
    expect(queue.size).toBeLessThan(2);
    queue.clear();
    release?.();
  });

  it("retains bounded history and supports explicit cleanup", async () => {
    const queue = memoryQueue(
      { work: async (value: number) => value },
      { historyLimit: 2 }
    );

    await Promise.all(queue.addMany("work", [1, 2, 3]));
    expect(queue.list("succeeded")).toHaveLength(2);

    const removed = queue.cleanup({ olderThan: 0, limit: 1 });
    expect(removed).toHaveLength(1);
    expect(queue.list("succeeded")).toHaveLength(1);
  });

  it("drains on close by default and rejects future work", async () => {
    const values: number[] = [];
    const queue = memoryQueue(
      {
        work: async (value: number) => {
          values.push(value);
        },
      },
      { autoStart: false }
    );

    queue.addMany("work", [1, 2, 3]);
    await queue.close();

    expect(values).toEqual([1, 2, 3]);
    expect(() => queue.add("work", 4)).toThrow(QueueClosedError);
  });

  it("validates configuration and job options early", () => {
    expect(() => memoryQueue({})).toThrow("At least one job handler");
    expect(() =>
      memoryQueue({ work: async () => undefined }, { concurrency: 0 })
    ).toThrow("concurrency");
    expect(() =>
      memoryQueue(
        { work: async () => undefined },
        { rateLimit: { limit: 1, interval: 0 } }
      )
    ).toThrow("rateLimit.interval");

    const queue = memoryQueue(
      { work: async (value: number) => value },
      { autoStart: false }
    );
    queue.add("work", 1, { id: "stable" });
    expect(() => queue.add("work", 2, { id: "stable" })).toThrow(
      'Job ID "stable" already exists'
    );
    expect(() => queue.add("work", 3, { delay: -1 })).toThrow("delay");
    queue.clear();
  });
});
