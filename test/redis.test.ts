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

describeRedis("Redis driver", () => {
  let client: RedisClientType;
  let commandClient: RedisCommandClient;
  let prefix: string;

  beforeAll(async () => {
    client = createClient({ url: redisUrl });
    await client.connect();
    commandClient = client as unknown as RedisCommandClient;
  });

  // A unique namespace per test isolates cases without flushing a database
  // that other test files are using at the same time. Vitest runs files in
  // parallel, so flushDb() here wiped examples/testing/jobs.redis.test.ts
  // mid-run and made it fail intermittently.
  beforeEach(() => {
    prefix = `enqiu-test:${randomUUID()}`;
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

  /** Every queue in a test shares that test's namespace. */
  function testDriver(options: { pollInterval?: number; visibilityTimeout?: number } = {}) {
    return redis(commandClient, { ...options, prefix });
  }

  it("accepts and runs a directly called job", async () => {
    const jobs = enqiu(
      {
        double: async (value: number) => value * 2,
      },
      {
        name: "direct",
        driver: testDriver({ pollInterval: 5 }),
        worker: { concurrency: 2 },
      }
    );

    const handle = await jobs.double(21);
    await expect(handle.result).resolves.toBe(42);
    expect((await handle.refresh()).status).toBe("succeeded");
    await jobs.worker.close();
  });

  it("enforces distributed per-key concurrency", async () => {
    const releases: Array<() => void> = [];
    const active = new Map<string, number>();
    const peaks = new Map<string, number>();
    const definitions = {
      work: job({
        input: schema<{ organizationId: string }>(),
        concurrency: {
          limit: 1,
          by: (input) => input.organizationId,
        },
        run: async ({ organizationId }: { organizationId: string }) => {
          const count = (active.get(organizationId) ?? 0) + 1;
          active.set(organizationId, count);
          peaks.set(
            organizationId,
            Math.max(peaks.get(organizationId) ?? 0, count)
          );
          await new Promise<void>((resolve) => releases.push(resolve));
          active.set(organizationId, count - 1);
        },
      }),
    };
    const driver = testDriver({
      pollInterval: 5,
      visibilityTimeout: 1_000,
    });
    const firstWorker = enqiu(definitions, {
      name: "keyed",
      driver,
      worker: { concurrency: 4 },
    });
    const secondWorker = enqiu(definitions, {
      name: "keyed",
      driver,
      worker: { concurrency: 4 },
    });

    const handles = await Promise.all([
      firstWorker.work({ organizationId: "a" }),
      firstWorker.work({ organizationId: "a" }),
      firstWorker.work({ organizationId: "b" }),
      firstWorker.work({ organizationId: "b" }),
    ]);
    await waitFor(() => releases.length === 2);
    while (releases.length > 0 || (await firstWorker.queue.stats()).running > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all(handles.map((handle) => handle.result));

    expect(peaks).toEqual(
      new Map([
        ["a", 1],
        ["b", 1],
      ])
    );
    await Promise.all([
      firstWorker.worker.close(),
      secondWorker.worker.close(),
    ]);
  });

  it("supports global pause, expiration, and resume", async () => {
    const calls: number[] = [];
    const jobs = enqiu(
      {
        work: job({
          input: schema<number>(),
          expiresIn: 40,
          run: async (value) => {
            calls.push(value);
          },
        }),
      },
      {
        name: "pause",
        driver: testDriver({ pollInterval: 5 }),
        worker: { concurrency: 2 },
      }
    );

    await jobs.queue.pause();
    const handle = await jobs.work(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await jobs.queue.resume();

    await expect(handle.result).rejects.toMatchObject({
      name: "JobExpiredError",
    });
    expect(calls).toEqual([]);
    expect((await jobs.queue.stats()).expired).toBe(1);
    await jobs.worker.close();
  });

  it("debounces and retains idempotent results", async () => {
    const values: number[] = [];
    const jobs = enqiu(
      {
        rebuild: job({
          input: schema<{ key: string; value: number }>(),
          debounce: {
            wait: 40,
            mode: "trailing",
            by: (input) => input.key,
          },
          run: async (input) => {
            values.push(input.value);
            return input.value;
          },
        }),
      },
      {
        name: "dedupe",
        driver: testDriver({ pollInterval: 5 }),
        worker: { concurrency: 2 },
      }
    );

    const first = await jobs.rebuild(
      { key: "docs", value: 1 },
      { idempotencyKey: "rebuild-docs", idempotencyTtl: 500 }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await jobs.rebuild(
      { key: "docs", value: 2 },
      { idempotencyKey: "rebuild-docs", idempotencyTtl: 500 }
    );
    expect(second.id).toBe(first.id);
    await expect(first.result).resolves.toBe(2);
    expect(values).toEqual([2]);

    const completedDuplicate = await jobs.rebuild(
      { key: "docs", value: 3 },
      { idempotencyKey: "rebuild-docs", idempotencyTtl: 500 }
    );
    expect(completedDuplicate.id).toBe(first.id);
    await expect(completedDuplicate.result).resolves.toBe(2);
    await jobs.worker.close();
  });

  it("lists, redrives, and cleans terminal work", async () => {
    let fail = true;
    const jobs = enqiu(
      {
        work: async (value: number) => {
          if (fail) throw new Error("temporary");
          return value;
        },
      },
      {
        name: "inspection",
        driver: testDriver({ pollInterval: 5 }),
        worker: { concurrency: 1 },
      }
    );

    const failed = await jobs.work(7);
    await expect(failed.result).rejects.toThrow("temporary");
    expect(
      (await jobs.queue.list({ status: "failed" })).jobs.map((item) => item.id)
    ).toContain(failed.id);

    fail = false;
    const redriven = await jobs.queue.redrive(failed.id);
    await expect(redriven.result).resolves.toBe(7);
    const removed = await jobs.queue.cleanup({
      status: "succeeded",
      limit: 10,
    });
    expect(removed).toContain(failed.id);
    expect(await jobs.queue.get(failed.id)).toBeUndefined();
    await jobs.worker.close();
  });

  it("persists and coordinates cron schedules", async () => {
    const values: string[] = [];
    const jobs = enqiu(
      {
        digest: async (audience: string) => {
          values.push(audience);
        },
      },
      {
        name: "cron",
        driver: testDriver({ pollInterval: 5 }),
        worker: { concurrency: 1 },
      }
    );

    const schedule = await jobs.digest.schedule({
      id: "weekday-digest",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Nicosia",
      input: "active-users",
    });
    const due = Date.now();
    // Keys must be derived from this test's namespace; queueKeys builds them
    // as `${prefix}:{${queueName}}`.
    await client.hSet(
      `${prefix}:{cron}:schedule:weekday-digest`,
      "nextRunAt",
      String(due)
    );
    await client.zAdd(`${prefix}:{cron}:schedules`, {
      score: due,
      value: "weekday-digest",
    });

    await waitFor(() => values.length === 1);
    expect(values).toEqual(["active-users"]);
    expect((await schedule.refresh()).nextRunAt).toBeGreaterThan(due);

    await schedule.pause();
    expect((await schedule.refresh()).status).toBe("paused");
    await schedule.resume();
    expect((await schedule.refresh()).status).toBe("active");
    await schedule.remove();
    await expect(schedule.refresh()).rejects.toThrow("does not exist");
    await jobs.worker.close();
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 2_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Redis state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
