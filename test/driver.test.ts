import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateJobIdError,
  enqiu,
  type JobsApi,
  type JobDefinitions,
} from "../src/index.js";

let open: Array<JobsApi<JobDefinitions>> = [];

function makeJobs<Definitions extends JobDefinitions>(
  definitions: Definitions,
  options?: Parameters<typeof enqiu>[1]
) {
  const jobs = enqiu(definitions, options);
  open.push(jobs as unknown as JobsApi<JobDefinitions>);
  return jobs;
}

afterEach(async () => {
  await Promise.all(
    open.map((jobs) => jobs.worker.close({ drain: false }).catch(() => undefined))
  );
  open = [];
});

describe("driver seam through the public API", () => {
  it("reports stats that stay consistent with the queue's own totals", async () => {
    const jobs = makeJobs({
      ok: async (n: number) => n,
      bad: async () => {
        throw new Error("nope");
      },
    });

    await jobs.ok(1);
    await jobs.bad(undefined as never).then((handle) =>
      handle.result.catch(() => undefined)
    );
    await jobs.worker.onIdle();

    const stats = await jobs.queue.stats();
    const summed =
      stats.queued +
      stats.scheduled +
      stats.running +
      stats.succeeded +
      stats.failed +
      stats.cancelled +
      stats.expired;
    expect(summed).toBe(stats.total);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it("keeps status counts exact across cancel, retry and cleanup", async () => {
    const jobs = makeJobs(
      { work: async (n: number) => n },
      { worker: { autoStart: false } }
    );

    const handles = await jobs.work.bulk([1, 2, 3, 4]);
    expect((await jobs.queue.stats()).queued).toBe(4);

    await handles[0]!.cancel("not needed");
    let stats = await jobs.queue.stats();
    expect(stats.queued).toBe(3);
    expect(stats.cancelled).toBe(1);
    expect(stats.total).toBe(4);

    // Redriving a cancelled job moves it back out of the terminal counts.
    await jobs.queue.redrive(handles[0]!.id);
    stats = await jobs.queue.stats();
    expect(stats.queued).toBe(4);
    expect(stats.cancelled).toBe(0);

    await jobs.worker.start();
    await jobs.worker.onIdle();
    stats = await jobs.queue.stats();
    expect(stats.succeeded).toBe(4);

    const removed = await jobs.queue.cleanup({ status: "succeeded" });
    expect(removed).toHaveLength(4);
    stats = await jobs.queue.stats();
    expect(stats.total).toBe(0);
    expect(stats.succeeded).toBe(0);
  });

  it("paginates list results with a cursor", async () => {
    const jobs = makeJobs(
      { work: async (n: number) => n },
      { worker: false }
    );
    await jobs.work.bulk([1, 2, 3, 4, 5]);

    const first = await jobs.queue.list({ limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.cursor).toBeDefined();

    const second = await jobs.queue.list({ limit: 2, cursor: first.cursor });
    expect(second.jobs).toHaveLength(2);
    expect(second.cursor).toBeDefined();

    const third = await jobs.queue.list({ limit: 2, cursor: second.cursor });
    expect(third.jobs).toHaveLength(1);
    // The final page ends the walk rather than looping.
    expect(third.cursor).toBeUndefined();

    const ids = [...first.jobs, ...second.jobs, ...third.jobs].map(
      (item) => item.id
    );
    expect(new Set(ids).size).toBe(5);
  });

  it("filters list results by name, status and creation window", async () => {
    const jobs = makeJobs(
      { alpha: async (n: number) => n, beta: async (n: number) => n },
      { worker: false }
    );
    await jobs.alpha(1);
    await jobs.beta(2);

    const byName = await jobs.queue.list({ name: "alpha" });
    expect(byName.jobs).toHaveLength(1);
    expect(byName.jobs[0]!.name).toBe("alpha");

    const byStatus = await jobs.queue.list({ status: "queued" });
    expect(byStatus.jobs).toHaveLength(2);
    expect(await jobs.queue.list({ status: "succeeded" })).toEqual({ jobs: [] });

    const future = await jobs.queue.list({ after: Date.now() + 60_000 });
    expect(future.jobs).toHaveLength(0);
    const past = await jobs.queue.list({ before: Date.now() - 60_000 });
    expect(past.jobs).toHaveLength(0);
  });

  it("rejects an out-of-range limit and a malformed cursor", async () => {
    const jobs = makeJobs({ work: async (n: number) => n }, { worker: false });

    await expect(jobs.queue.list({ limit: 0 })).rejects.toThrow(
      "list.limit must be an integer between 1 and 1000"
    );
    await expect(jobs.queue.list({ limit: 1001 })).rejects.toThrow(
      "list.limit"
    );
    await expect(jobs.queue.list({ limit: 1.5 })).rejects.toThrow("list.limit");
    await expect(jobs.queue.list({ cursor: "nonsense" })).rejects.toThrow(
      "Invalid list cursor"
    );
    await expect(jobs.queue.list({ cursor: "-1" })).rejects.toThrow(
      "Invalid list cursor"
    );
  });

  it("refuses to redrive a job that cannot be redriven", async () => {
    const jobs = makeJobs({ work: async (n: number) => n }, { worker: false });
    await expect(jobs.queue.redrive("missing")).rejects.toThrow(
      'Job "missing" cannot be redriven'
    );

    const handle = await jobs.work(1);
    // A queued job is not in a terminal state, so it is not redrivable either.
    await expect(jobs.queue.redrive(handle.id)).rejects.toThrow(
      "cannot be redriven"
    );
  });

  it("separates queue-wide pause from this process's worker", async () => {
    const jobs = makeJobs({ work: async (n: number) => n });
    expect(jobs.worker.running).toBe(true);

    await jobs.worker.pause();
    expect(jobs.worker.running).toBe(false);
    const handle = await jobs.work(1);
    expect((await jobs.queue.stats()).queued).toBe(1);

    await jobs.worker.resume();
    expect(jobs.worker.running).toBe(true);
    await expect(handle.result).resolves.toBe(1);

    await jobs.queue.pause();
    await jobs.work(2);
    expect((await jobs.queue.stats()).queued).toBe(1);
    await jobs.queue.resume();
    await jobs.worker.onIdle();
    expect((await jobs.queue.stats()).succeeded).toBe(2);
  });

  it("applies a concurrency limit set through either surface", async () => {
    let peak = 0;
    let active = 0;
    const jobs = makeJobs(
      {
        work: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        },
      },
      { worker: { autoStart: false } }
    );

    await jobs.queue.setConcurrency(2);
    await jobs.work.bulk([1, 2, 3, 4, 5, 6]);
    await jobs.worker.start();
    await jobs.worker.onIdle();
    expect(peak).toBeLessThanOrEqual(2);

    // Pause first: the worker is still running at 2 from the previous batch,
    // so jobs added now would start before the new limit is applied.
    await jobs.worker.pause();
    peak = 0;
    await jobs.work.bulk([1, 2, 3, 4]);
    await jobs.worker.start({ concurrency: 1 });
    await jobs.worker.onIdle();
    expect(peak).toBe(1);
  });

  it("reads a job back by id and returns undefined for an unknown one", async () => {
    const jobs = makeJobs({ work: async (n: number) => n }, { worker: false });
    const handle = await jobs.work(7);

    const snapshot = await jobs.queue.get(handle.id);
    expect(snapshot?.id).toBe(handle.id);
    expect(snapshot?.input).toBe(7);
    expect(await jobs.queue.get("missing")).toBeUndefined();

    const refreshed = await handle.refresh();
    expect(refreshed.id).toBe(handle.id);
    expect(refreshed.status).toBe("queued");
  });

  it("rejects bulk ids that do not line up with the inputs", async () => {
    const jobs = makeJobs({ work: async (n: number) => n }, { worker: false });
    await expect(
      jobs.work.bulk([1, 2, 3], { ids: ["a", "b"] })
    ).rejects.toThrow("bulk ids must match the number of inputs");

    const handles = await jobs.work.bulk([1, 2], { ids: ["a", "b"] });
    expect(handles.map((handle) => handle.id)).toEqual(["a", "b"]);
  });

  it("rejects job names that collide with the api surface", () => {
    expect(() => enqiu({ queue: async () => 1 })).toThrow(
      '"queue" is reserved by enqiu'
    );
    expect(() => enqiu({ worker: async () => 1 })).toThrow(
      '"worker" is reserved by enqiu'
    );
    expect(() => enqiu({})).toThrow("At least one job definition is required");
  });

  it("closes without draining when asked", async () => {
    const jobs = makeJobs(
      { work: async (n: number) => n },
      { worker: { autoStart: false } }
    );
    await jobs.work.bulk([1, 2, 3]);
    await jobs.worker.close({ drain: false });
    expect(jobs.worker.running).toBe(false);
  });
});

describe("duplicate job IDs", () => {
  it("reports a colliding ID with a catchable typed error", async () => {
    const jobs = makeJobs({ work: async (n: number) => n }, { worker: false });
    await jobs.work(1, { id: "fixed" });

    // Schedules depend on telling "another worker already claimed this tick"
    // from a real failure, so this must be matchable by type, not by message.
    await expect(jobs.work(2, { id: "fixed" })).rejects.toBeInstanceOf(
      DuplicateJobIdError
    );
    await expect(jobs.work(3, { id: "fixed" })).rejects.toMatchObject({
      name: "DuplicateJobIdError",
      jobId: "fixed",
    });
    // Still an Error carrying the old wording, so existing handling survives.
    await expect(jobs.work(4, { id: "fixed" })).rejects.toThrow(
      'Job ID "fixed" already exists'
    );
  });
});
