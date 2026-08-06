/**
 * Fan-out of queue events, local and remote.
 *
 * A Redis queue spans processes, so a job started by one worker has to reach
 * listeners in all of them. Every state change is appended to a Redis stream,
 * and each process tails that stream from wherever it was when it first
 * subscribed. Purely local concerns — `error` and `idle` — never travel.
 */

import { errorFromSerialized, toError } from "../internal/errors.js";
import { sleep } from "../internal/timing.js";
import { firstStreamEntryId, streamEntries } from "./stream.js";
import { snapshotForEvent } from "./snapshot.js";
import type { JobSnapshot } from "../memory.js";
import type { RedisQueueEventMap } from "./types.js";

/** Events that describe this process only, and so are never published. */
type LocalEvent = "error" | "idle";

export interface RedisEventsOptions {
  command(command: string, arguments_: string[]): Promise<unknown>;
  /** Reads the job a stream entry refers to. */
  getSnapshot(id: string): Promise<JobSnapshot | undefined>;
  eventsKey: string;
  pollInterval: number;
  isClosed(): boolean;
}

export class RedisEvents {
  private readonly listeners = new Map<
    keyof RedisQueueEventMap,
    Set<(payload: never) => void>
  >();

  private loop: Promise<void> | undefined;
  private cursor: string | undefined;

  constructor(private readonly options: RedisEventsOptions) {}

  on<Event extends keyof RedisQueueEventMap>(
    event: Event,
    listener: (payload: RedisQueueEventMap[Event]) => void
  ): () => void {
    let group = this.listeners.get(event);
    if (!group) {
      group = new Set();
      this.listeners.set(event, group);
    }
    group.add(listener as (payload: never) => void);
    if (!isLocal(event)) {
      this.ensureLoop();
    }
    return () => {
      group?.delete(listener as (payload: never) => void);
    };
  }

  emit<Event extends keyof RedisQueueEventMap>(
    event: Event,
    payload: RedisQueueEventMap[Event]
  ): void {
    const group = this.listeners.get(event);
    if (!group) {
      return;
    }
    for (const listener of group) {
      try {
        listener(payload as never);
      } catch {
        // Observers cannot interrupt queue processing.
      }
    }
  }

  /** Appends an entry other processes will pick up. */
  async publish(type: string, id: string): Promise<void> {
    await this.options.command("XADD", [
      this.options.eventsKey,
      "MAXLEN",
      "~",
      "10000",
      "*",
      "type",
      type,
      "id",
      id,
      "at",
      String(Date.now()),
    ]);
  }

  /** Awaits the tail loop, so close() does not leave it running. */
  async drain(): Promise<void> {
    await this.loop;
  }

  private ensureLoop(): void {
    if (this.loop || this.options.isClosed()) {
      return;
    }
    this.loop = this.read().finally(() => {
      this.loop = undefined;
    });
  }

  private async read(): Promise<void> {
    if (this.cursor === undefined) {
      // Start at the tail: a new subscriber wants what happens next, not a
      // replay of everything the queue has ever done.
      const latest = await this.options.command("XREVRANGE", [
        this.options.eventsKey,
        "+",
        "-",
        "COUNT",
        "1",
      ]);
      this.cursor = firstStreamEntryId(latest) ?? "0-0";
    }
    while (!this.options.isClosed() && this.hasRemoteListeners()) {
      try {
        const result = await this.options.command("XREAD", [
          "COUNT",
          "100",
          "STREAMS",
          this.options.eventsKey,
          this.cursor,
        ]);
        for (const entry of streamEntries(result)) {
          this.cursor = entry.id;
          await this.dispatch(entry.fields);
        }
      } catch (cause) {
        this.emit("error", toError(cause));
      }
      await sleep(this.options.pollInterval);
    }
  }

  private hasRemoteListeners(): boolean {
    for (const [event, listeners] of this.listeners) {
      if (!isLocal(event) && listeners.size > 0) {
        return true;
      }
    }
    return false;
  }

  private async dispatch(fields: ReadonlyMap<string, string>): Promise<void> {
    const type = fields.get("type") as keyof RedisQueueEventMap | undefined;
    const id = fields.get("id");
    if (!type || !id || isLocal(type)) {
      return;
    }
    const value = await this.options.getSnapshot(id);
    if (!value) {
      return;
    }
    const at = Number(fields.get("at") ?? Date.now());
    const snapshot = snapshotForEvent(type, value, at);

    if (type === "retry") {
      this.emit("retry", {
        job: snapshot,
        error: errorFromSerialized(snapshot.error),
        delay: Math.max(0, snapshot.runAt - at),
      });
      return;
    }
    if (type === "log") {
      const entry = snapshot.logs?.at(-1);
      if (entry) {
        this.emit("log", { job: snapshot, entry });
      }
      return;
    }
    if (type === "recovered") {
      this.emit("recovered", snapshot);
      return;
    }
    this.emit(
      type as Exclude<keyof RedisQueueEventMap, LocalEvent | "retry" | "log" | "recovered">,
      snapshot
    );
  }
}

function isLocal(event: keyof RedisQueueEventMap): event is LocalEvent {
  return event === "error" || event === "idle";
}
