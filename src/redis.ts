/**
 * Public entry point for the Redis driver.
 *
 * `redis()` returns a factory that builds its own queue, so nothing outside
 * this module needs an import edge to the engine — which is what lets a
 * bundler drop the driver, and its Lua, from a memory-only application.
 */

import { positiveNumber } from "./internal/validate.js";
import { RedisDriverAdapter } from "./redis/adapter.js";
import type { DriverHandlers, DriverQueueOptions, QueueDriver } from "./driver.js";
import type {
  RedisCommandClient,
  RedisDriver,
  RedisDriverConfig,
  RedisDriverOptions,
} from "./redis/types.js";

export { RedisQueue } from "./redis/queue.js";
export type {
  RedisAddOptions,
  RedisCommandClient,
  RedisDriver,
  RedisDriverConfig,
  RedisDriverOptions,
  RedisJob,
  RedisListOptions,
  RedisListPage,
  RedisQueueEventMap,
  RedisQueueOptions,
  RedisRetryOptions,
  RedisScheduleHandle,
  RedisScheduleRegistration,
  RedisScheduleSnapshot,
} from "./redis/types.js";

export function redis(
  client: RedisCommandClient,
  options: RedisDriverOptions = {}
): RedisDriver {
  if (
    typeof client.send !== "function" &&
    typeof client.sendCommand !== "function"
  ) {
    throw new TypeError(
      "Redis client must expose send(command, args) or sendCommand(args)"
    );
  }

  const prefix = options.prefix?.trim() || "enqiu";
  const pollInterval = options.pollInterval ?? 100;
  const visibilityTimeout = options.visibilityTimeout ?? 30_000;
  const retention = options.retention ?? 7 * 24 * 60 * 60 * 1000;

  positiveNumber("pollInterval", pollInterval);
  positiveNumber("visibilityTimeout", visibilityTimeout);
  positiveNumber("retention", retention);

  const config: RedisDriverConfig = {
    client,
    prefix,
    pollInterval,
    visibilityTimeout,
    retention,
  };
  return {
    kind: "redis",
    ...config,
    createQueue: (
      handlers: DriverHandlers,
      queueOptions: DriverQueueOptions
    ): QueueDriver => new RedisDriverAdapter(handlers, config, queueOptions),
  };
}
