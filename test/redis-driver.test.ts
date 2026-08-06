import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createClient, type RedisClientType } from "redis";
import {
  job,
  enqiu,
  redis,
  type RedisCommandClient,
  type StandardSchemaV1,
} from "../src/index.js";

const redisUrl = process.env.ENQIU_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function schema<Input>(): StandardSchemaV1<Input> {
  return {
    "~standard": {
      version: 1,
      vendor: "enqiu-test",
      validate(value) {
        return { value: value as Input };
      },
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 3_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Redis state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describeRedis("Redis driver surface", () => {
  let client: RedisClientType;
  let commandClient: RedisCommandClient;
  let prefix: string;

  beforeAll(async () => {
    client = createClient({ url: redisUrl });
    await client.connect();
    commandClient = client as unknown as RedisCommandClient;
  });

  beforeEach(() => {
    prefix = `enqiu-driver:${randomUUID()}`;
  });

  afterEach(async () => {
    for await (const keys of client.scanIterator({
      MATCH: `${prefix}:*`,
      COUNT: 100,
    })) {
      if (keys.length > 0) await client.del(keys);
    }
  });

  afterAll(async () => {
    await client.quit();
  });

  function testDriver(options: {
    pollInterval?: number;
    visibilityTimeout?: number;
    retention?: number;
  } = {}) {
    return redis(commandClient, { pollInterval: 5, ...options, prefix });
  }

  it("streams lifecycle events to subscribers", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      {
        name: "events",
        driver: testDriver(),
        worker: { concurrency: 1 },
      }
    );
    const seen: string[] = [];
    // Subscribe first: the event loop starts from the stream's current tail.
    const off = jobs.queue.on("succeeded", (snapshot) => {
      seen.push(`succeeded:${snapshot.id}`);
    });
    jobs.queue.on("added", (snapshot) => seen.push(`added:${snapshot.id}`));
    jobs.queue.on("started", (snapshot) => seen.push(`started:${snapshot.id}`));

    const handle = await jobs.work(5);
    await expect(handle.result).resolves.toBe(5);
    await waitFor(() => seen.some((entry) => entry.startsWith("succeeded:")));

    expect(seen).toContain(`added:${handle.id}`);
    expect(seen).toContain(`started:${handle.id}`);
    expect(seen).toContain(`succeeded:${handle.id}`);

    off();
    await jobs.worker.close();
  });

  it("reports a retry and then a failure to subscribers", async () => {
    let attempts = 0;
    const jobs = enqiu(
      {
        flaky: job({
          input: schema<number>(),
          retry: { attempts: 2, backoff: 5 },
          run: async () => {
            attempts += 1;
            throw new Error("always fails");
          },
        }),
      },
      { name: "retry", driver: testDriver(), worker: { concurrency: 1 } }
    );
    const retries: number[] = [];
    const failures: string[] = [];
    jobs.queue.on("retry", (payload) => retries.push(payload.delay));
    jobs.queue.on("failed", (snapshot) => failures.push(snapshot.id));

    const handle = await jobs.flaky(1);
    await expect(handle.result).rejects.toThrow("always fails");
    await waitFor(() => failures.length === 1);

    expect(attempts).toBe(2);
    expect(retries).toHaveLength(1);
    expect((await handle.refresh()).status).toBe("failed");
    await jobs.worker.close();
  });

  it("persists progress and logs through Redis", async () => {
    const jobs = enqiu(
      {
        work: job({
          input: schema<number>(),
          run: async (value, context) => {
            await context.reportProgress({ completed: 1, total: 2 });
            context.log.info("halfway", { value });
            context.log.warn("careful");
            return value;
          },
        }),
      },
      { name: "telemetry", driver: testDriver(), worker: { concurrency: 1 } }
    );

    const handle = await jobs.work(3);
    await expect(handle.result).resolves.toBe(3);
    await waitFor(async () => {
      const snapshot = await jobs.queue.get(handle.id);
      return (snapshot?.logs?.length ?? 0) >= 2;
    });

    const snapshot = await jobs.queue.get(handle.id);
    expect(snapshot?.progress).toEqual({ completed: 1, total: 2 });
    expect(snapshot?.logs?.map((entry) => entry.message)).toEqual([
      "halfway",
      "careful",
    ]);
    await jobs.worker.close();
  });

  it("times out an attempt and aborts its signal", async () => {
    let aborted = false;
    const jobs = enqiu(
      {
        slow: job({
          input: schema<number>(),
          timeout: 30,
          run: async (_value, context) => {
            context.signal.addEventListener("abort", () => {
              aborted = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 500));
          },
        }),
      },
      { name: "timeout", driver: testDriver(), worker: { concurrency: 1 } }
    );

    const handle = await jobs.slow(1);
    // The error class does not survive Redis; only the serialized name and
    // message do, so the awaiting caller sees a JobFailedError that carries
    // the timeout's message.
    await expect(handle.result).rejects.toThrow("timed out after 30ms");
    expect((await handle.refresh()).error?.name).toBe("JobTimeoutError");
    expect(aborted).toBe(true);
    await jobs.worker.close();
  });

  it("cancels a job that has not started", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      { name: "cancel", driver: testDriver(), worker: false }
    );

    const handle = await jobs.work(1);
    await expect(handle.cancel("not needed")).resolves.toBe(true);
    expect((await handle.refresh()).status).toBe("cancelled");
    await expect(handle.result).rejects.toMatchObject({
      name: "JobCancelledError",
    });
    // Cancelling an already-terminal job reports that nothing changed.
    await expect(handle.cancel()).resolves.toBe(false);
    await expect(jobs.queue.get("missing")).resolves.toBeUndefined();
    await jobs.worker.close();
  });

  it("submits in bulk and lists with a cursor", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      { name: "bulk", driver: testDriver(), worker: false }
    );

    const handles = await jobs.work.bulk([1, 2, 3, 4, 5]);
    expect(handles).toHaveLength(5);

    const first = await jobs.queue.list({ limit: 2 });
    expect(first.jobs).toHaveLength(2);
    const second = await jobs.queue.list({ limit: 2, cursor: first.cursor });
    expect(second.jobs.length).toBeGreaterThan(0);

    const byName = await jobs.queue.list({ name: "work", limit: 10 });
    expect(byName.jobs).toHaveLength(5);
    const byStatus = await jobs.queue.list({ status: "queued", limit: 10 });
    expect(byStatus.jobs).toHaveLength(5);

    await expect(jobs.queue.list({ limit: 0 })).rejects.toThrow("list.limit");
    await expect(jobs.queue.list({ cursor: "bad" })).rejects.toThrow(
      "Invalid list cursor"
    );
    await jobs.worker.close();
  });

  it("redrives a failed job and cleans up terminal work", async () => {
    let succeed = false;
    const jobs = enqiu(
      {
        work: job({
          input: schema<number>(),
          run: async (value) => {
            if (!succeed) throw new Error("first run fails");
            return value;
          },
        }),
      },
      { name: "redrive", driver: testDriver(), worker: { concurrency: 1 } }
    );

    const handle = await jobs.work(1);
    await expect(handle.result).rejects.toThrow("first run fails");

    succeed = true;
    const redriven = await jobs.queue.redrive(handle.id);
    await expect(redriven.result).resolves.toBe(1);

    await expect(jobs.queue.redrive("missing")).rejects.toThrow(
      "cannot be redriven"
    );

    const removed = await jobs.queue.cleanup({ status: "succeeded" });
    expect(removed).toContain(handle.id);
    await expect(jobs.queue.cleanup({ limit: -1 })).rejects.toThrow(
      "cleanup.limit"
    );
    await expect(jobs.queue.cleanup({ olderThan: -1 })).rejects.toThrow(
      "cleanup.olderThan"
    );
    await jobs.worker.close();
  });

  it("returns the same job for a repeated idempotency key", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      { name: "idem", driver: testDriver(), worker: false }
    );

    const first = await jobs.work(1, { idempotencyKey: "once" });
    const second = await jobs.work(2, { idempotencyKey: "once" });
    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);
    expect(first.deduplicated).toBe(false);
    await jobs.worker.close();
  });

  it("sets queue-wide and worker concurrency", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      { name: "limits", driver: testDriver(), worker: { concurrency: 1 } }
    );

    await jobs.queue.setConcurrency(4);
    await expect(jobs.queue.setConcurrency(0)).rejects.toThrow(
      "global concurrency must be a positive integer"
    );

    await jobs.worker.pause();
    expect(jobs.worker.running).toBe(false);
    await jobs.worker.start({ concurrency: 2 });
    expect(jobs.worker.running).toBe(true);

    const handle = await jobs.work(9);
    await expect(handle.result).resolves.toBe(9);
    await jobs.worker.close();
  });

  it("refuses to hand one schedule id to a second job", async () => {
    const jobs = enqiu(
      {
        alpha: async (value: string) => value,
        beta: async (value: string) => value,
      },
      { name: "conflict", driver: testDriver(), worker: false }
    );

    await jobs.alpha.schedule({
      id: "shared",
      cron: "0 9 * * *",
      input: "a",
    });
    await expect(
      jobs.beta.schedule({ id: "shared", cron: "0 9 * * *", input: "b" })
    ).rejects.toThrow('Schedule "shared" already belongs to job "alpha"');
    await jobs.worker.close();
  });

  it("rejects an invalid driver client and out-of-range tuning", () => {
    expect(() => redis({} as RedisCommandClient)).toThrow(
      "Redis client must expose send(command, args) or sendCommand(args)"
    );
    expect(() => redis(commandClient, { pollInterval: 0 })).toThrow(
      "pollInterval must be a positive finite number"
    );
    expect(() => redis(commandClient, { retention: -1 })).toThrow(
      "retention must be a positive finite number"
    );
    // 0 is valid — it means retain no history, same as the memory driver.
    expect(() =>
      enqiu(
        { work: async (value: number) => value },
        { driver: testDriver(), worker: false, historyLimit: -1 }
      )
    ).toThrow("historyLimit must be a non-negative integer");
  });

  it("waits for the whole queue in onIdle, not just local work", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      { name: "idle", driver: testDriver(), worker: { concurrency: 2 } }
    );

    await jobs.work.bulk([1, 2, 3, 4, 5, 6]);
    // Called immediately after submitting, nothing has been claimed yet.
    // Waiting only on in-flight work would return here with a full backlog.
    await jobs.worker.onIdle();

    const stats = await jobs.queue.stats();
    expect(stats.queued).toBe(0);
    expect(stats.scheduled).toBe(0);
    expect(stats.running).toBe(0);
    expect(stats.succeeded).toBe(6);
    await jobs.worker.close();
  });

  it("honours a `when` predicate and a function backoff on Redis", async () => {
    let attempts = 0;
    const backoffCalls: number[] = [];

    const jobs = enqiu(
      {
        permanent: job({
          input: schema<number>(),
          retry: {
            attempts: 5,
            // Both of these are code, not data. They never reach Redis; the
            // worker resolves them from its own definition of the job.
            when: (error) => !error.message.includes("permanent"),
            backoff: (attempt) => {
              backoffCalls.push(attempt);
              return 5;
            },
          },
          run: async () => {
            attempts += 1;
            throw new Error("permanent: bad request");
          },
        }),
        transient: job({
          input: schema<number>(),
          retry: {
            attempts: 3,
            when: (error) => !error.message.includes("permanent"),
            backoff: (attempt) => {
              backoffCalls.push(attempt);
              return 5;
            },
          },
          run: async () => {
            attempts += 1;
            if (attempts < 3) throw new Error("503 transient");
            return "recovered";
          },
        }),
      },
      { name: "predicates", driver: testDriver(), worker: { concurrency: 1 } }
    );

    const permanent = await jobs.permanent(1);
    await expect(permanent.result).rejects.toThrow("permanent");
    expect(attempts).toBe(1);
    expect(backoffCalls).toEqual([]);
    expect((await permanent.refresh()).status).toBe("failed");

    attempts = 0;
    const transient = await jobs.transient(1);
    await expect(transient.result).resolves.toBe("recovered");
    expect(attempts).toBe(3);
    expect(backoffCalls).toEqual([1, 2]);

    await jobs.worker.close();
  });

  it("retains no history when historyLimit is 0, matching the memory driver", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      {
        name: "nohistory",
        driver: testDriver(),
        worker: { concurrency: 2 },
        historyLimit: 0,
      }
    );

    await jobs.work.bulk([1, 2, 3, 4, 5]);
    await jobs.worker.onIdle();

    // LTRIM cannot express an empty window, so the scripts DEL the list.
    const stats = await jobs.queue.stats();
    expect(stats.succeeded).toBe(0);
    expect(stats.total).toBe(0);
    await jobs.worker.close();
  });

  it("still bounds history at a positive limit", async () => {
    const jobs = enqiu(
      { work: async (value: number) => value },
      {
        name: "bounded",
        driver: testDriver(),
        worker: { concurrency: 2 },
        historyLimit: 2,
      }
    );

    await jobs.work.bulk([1, 2, 3, 4, 5]);
    await jobs.worker.onIdle();
    expect((await jobs.queue.stats()).succeeded).toBe(2);
    await jobs.worker.close();
  });

  it("finishes queued work on a draining close, and abandons it otherwise", async () => {
    const done: number[] = [];
    const make = (name: string) =>
      enqiu(
        {
          work: job({
            input: schema<number>(),
            run: async (value) => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              done.push(value);
              return value;
            },
          }),
        },
        { name, driver: testDriver(), worker: { concurrency: 1 } }
      );

    const draining = make("drain-yes");
    await draining.work.bulk([1, 2, 3, 4]);
    // The default drains: every queued job runs before close() resolves,
    // the same guarantee the in-memory driver gives.
    await draining.worker.close();
    expect(done).toHaveLength(4);
    expect((await draining.queue.stats()).queued).toBe(0);

    done.length = 0;
    const abrupt = make("drain-no");
    await abrupt.work.bulk([1, 2, 3, 4]);
    await abrupt.worker.close({ drain: false });
    expect(done.length).toBeLessThan(4);
  });
});
