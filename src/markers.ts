/**
 * Where cancellations are recorded.
 *
 * BullMQ has no cancelled state, and cancelling a job that has not started
 * removes it — so without a marker the only evidence is gone and `refresh()`
 * cannot tell "cancelled" from "never existed". A process-local Set was the
 * obvious first answer and the wrong one: it made a job's fate depend on which
 * process asked, and lost it entirely on restart.
 *
 * What is stored is the finished snapshot itself, not a reason beside a copy of
 * one: it is the only record left once the job is gone, and everything a reader
 * wants is already a field of `JobSnapshot`. Wrapping it meant three records of
 * one event that had to agree, reassembled differently by each reader.
 */

import type { Queue } from "bullmq";
import { backendClient } from "./backend.js";
import type { JobSnapshot } from "./types.js";

/** Deleted in batches: one HDEL naming every field can exceed Redis' limit. */
const DELETE_BATCH = 500;

export class CancellationMarkers {
  private readonly key: string;

  constructor(private readonly queue: Queue) {
    this.key = queue.toKey("enqiu:cancelled");
  }

  async write(id: string, snapshot: JobSnapshot): Promise<void> {
    const client = await backendClient(this.queue);
    await client.hset(this.key, { [id]: JSON.stringify(snapshot) });
  }

  async read(id: string): Promise<JobSnapshot | undefined> {
    const client = await backendClient(this.queue);
    const raw = await client.hget(this.key, id);
    return raw ? (JSON.parse(raw) as JobSnapshot) : undefined;
  }

  /** Markers outlive their jobs otherwise, so the hash grows forever. */
  async prune(threshold: number): Promise<void> {
    const client = await backendClient(this.queue);
    const stale = Object.entries(await client.hgetall(this.key))
      .filter(([, raw]) => {
        try {
          return ((JSON.parse(raw) as JobSnapshot).finishedAt ?? 0) <= threshold;
        } catch {
          return true;
        }
      })
      .map(([id]) => id);
    for (let from = 0; from < stale.length; from += DELETE_BATCH) {
      await client.hdel(this.key, ...stale.slice(from, from + DELETE_BATCH));
    }
  }
}
