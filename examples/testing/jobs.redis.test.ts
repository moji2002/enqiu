import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { describe, expect, it } from "vitest";
import { redis, type RedisCommandClient } from "enqiu";
import { createRedisJobs } from "./jobs.js";

const redisUrl = process.env.ENQIU_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis("email jobs with the Redis driver", () => {
  it("runs in an isolated namespace and closes injected resources", async () => {
    if (!redisUrl) return;

    const prefix = `enqiu-example:${randomUUID()}`;
    const client: RedisClientType = createClient({ url: redisUrl });
    let jobs: ReturnType<typeof createRedisJobs> | undefined;

    try {
      await client.connect();
      jobs = createRedisJobs({
        name: "consumer-testing",
        driver: redis(client as unknown as RedisCommandClient, {
          prefix,
          pollInterval: 5,
        }),
        worker: { concurrency: 1 },
      });

      const handle = await jobs.sendWelcome({ name: "Grace" });
      await expect(handle.result).resolves.toEqual({ subject: "Welcome, Grace" });
      expect((await handle.refresh()).status).toBe("succeeded");
    } finally {
      await jobs?.worker.close();

      if (client.isOpen) {
        for await (const keys of client.scanIterator({
          MATCH: `${prefix}:*`,
          COUNT: 100,
        })) {
          if (keys.length > 0) await client.del(keys);
        }
        await client.quit();
      }
    }
  });
});
