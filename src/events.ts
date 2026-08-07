/**
 * The queue's event stream, opened only if something asks for it.
 *
 * A `QueueEvents` costs a dedicated blocking Redis connection, which a
 * producer that never subscribes and never awaits a result should not pay for.
 *
 * Opening it from a known point matters. BullMQ's QueueEvents defaults to
 * reading from the present, which it evaluates when its read loop starts
 * rather than when it is constructed — so a caller that subscribed and
 * immediately submitted could miss its own `added` event. Capturing the stream
 * tail first and passing it as `lastEventId` closes that window: nothing
 * appended after this point can fall between the two.
 */

import { QueueEvents, type Queue } from "bullmq";
import { backendClient, type BullBase } from "./backend.js";

export class QueueEventStream {
  private opened: Promise<QueueEvents> | undefined;

  constructor(
    private readonly queue: Queue,
    private readonly base: BullBase
  ) {}

  open(): Promise<QueueEvents> {
    this.opened ??= (async () => {
      const client = await backendClient(this.queue);
      const tail = await client.xrevrange(
        this.queue.toKey("events"),
        "+",
        "-",
        "COUNT",
        "1"
      );
      const first = Array.isArray(tail) ? (tail[0] as unknown[]) : undefined;
      const events = new QueueEvents(this.queue.name, {
        ...this.base,
        lastEventId: first ? String(first[0]) : "0-0",
      });
      await events.waitUntilReady();
      return events;
    })();
    return this.opened;
  }

  /**
   * Waits only if a subscription is already opening.
   *
   * Submissions call this so that a caller who subscribed and then submitted
   * cannot outrun the stream — without it being the thing that opens one.
   */
  async settle(): Promise<void> {
    if (this.opened) await this.opened;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    await (await this.opened).close();
  }
}
