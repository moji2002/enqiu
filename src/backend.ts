/**
 * The one place Enqiu reaches past BullMQ's public API.
 *
 * `getBackend().client` is documented by BullMQ as a Redis-specific escape
 * hatch that is deliberately not part of `IQueueBackend`, so using it ties
 * Enqiu to the Redis backend. Two features need it — cancellation markers and
 * reading the tail of the event stream — and confining the cast to this file
 * keeps the coupling one import wide instead of scattered.
 *
 * Going through `RedisClient`, BullMQ's own abstraction, rather than an
 * ioredis-shaped interface is what keeps those two working on node-redis and
 * Bun, where `hset` takes a field map instead of positional arguments.
 * XREVRANGE is genuinely absent from it: nothing in BullMQ reads a stream
 * backwards.
 */

import type { ConnectionOptions, Queue, RedisClient } from "bullmq";

/** The BullMQ options every object Enqiu constructs is built from. */
export interface BullBase {
  readonly connection: ConnectionOptions;
  readonly prefix?: string;
}

export type BackendClient = RedisClient & {
  xrevrange(
    key: string,
    end: string,
    start: string,
    count: string,
    limit: string
  ): Promise<unknown>;
};

export async function backendClient(queue: Queue): Promise<BackendClient> {
  return (await queue.getBackend().client) as BackendClient;
}
