/**
 * Cron schedules held in Redis so several workers can share them.
 *
 * Each due schedule submits its occurrence under a deterministic job ID, so a
 * second worker reaching the same tick creates a duplicate ID rather than a
 * duplicate job. The schedule only advances once an occurrence is accepted.
 */

import { nextCronOccurrence, parseCron, validateTimeZone } from "../cron.js";
import {
  decodeJobValue as decode,
  encodeJobValue as encode,
} from "../codec.js";
import { toError } from "../internal/errors.js";
import { DuplicateJobIdError } from "../memory/errors.js";
import {
  ADVANCE_SCHEDULE_SCRIPT,
  UPSERT_SCHEDULE_SCRIPT,
} from "./scripts.js";
import type { queueKeys } from "./keys.js";
import type {
  RedisAddOptions,
  RedisScheduleHandle,
  RedisScheduleRegistration,
  RedisScheduleSnapshot,
} from "./types.js";

/** What schedules need from the queue that owns them. */
export interface ScheduleHost {
  command(command: string, arguments_: string[]): Promise<unknown>;
  eval(script: string, keys: string[], arguments_: string[]): Promise<unknown>;
  submit(name: string, input: unknown, options: RedisAddOptions): {
    accepted: Promise<void>;
  };
  emit(event: "error", payload: Error): void;
  assertOpen(): void;
  readonly keys: ReturnType<typeof queueKeys>;
  readonly name: string;
}

export class RedisSchedules {
  private readonly keys: ScheduleHost["keys"];
  private readonly queueName: string;

  constructor(private readonly host: ScheduleHost) {
    this.keys = host.keys;
    this.queueName = host.name;
  }

  async upsert(
    registration: RedisScheduleRegistration
  ): Promise<RedisScheduleHandle> {
    this.host.assertOpen();
    parseCron(registration.cron);
    const timezone = validateTimeZone(registration.timezone ?? "UTC");
    const id = registration.id?.trim() || registration.jobName;
    if (!id) {
      throw new TypeError("schedule.id must not be empty");
    }
    const nextRunAt = nextCronOccurrence(
      registration.cron,
      timezone,
      Date.now()
    );
    const result = await this.host.eval(
      UPSERT_SCHEDULE_SCRIPT,
      [this.keys.scheduleMeta, this.keys.schedules],
      [
        id,
        registration.jobName,
        registration.cron,
        timezone,
        String(nextRunAt),
        encode(registration.input),
        registration.catchUp ? "1" : "0",
        encode(registration.submit),
      ]
    );
    if (
      !Array.isArray(result) ||
      String(result[0]) !== "ok"
    ) {
      const owner = Array.isArray(result) ? String(result[1]) : "another job";
      throw new Error(
        `Schedule "${id}" already belongs to job "${owner}"`
      );
    }
    return new RedisScheduleHandleImpl(this, id, nextRunAt);
  }

  async get(
    id: string
  ): Promise<RedisScheduleSnapshot | undefined> {
    const values = await this.host.command("HMGET", [
      this.keys.scheduleMeta + id,
      "id",
      "jobName",
      "cron",
      "timezone",
      "status",
      "nextRunAt",
      "input",
      "catchUp",
    ]);
    if (!Array.isArray(values) || values[0] === null) {
      return undefined;
    }
    return {
      id: String(values[0]),
      jobName: String(values[1]),
      cron: String(values[2]),
      timezone: String(values[3]),
      status: String(values[4]) as "active" | "paused",
      nextRunAt: Number(values[5]),
      input: decode(String(values[6])),
      catchUp: String(values[7]) === "1",
    };
  }

  async pause(id: string): Promise<void> {
    if (!(await this.get(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.host.command("HSET", [
      this.keys.scheduleMeta + id,
      "status",
      "paused",
    ]);
    await this.host.command("ZREM", [this.keys.schedules, id]);
  }

  async resume(id: string): Promise<number> {
    const schedule = await this.get(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    const nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      Date.now()
    );
    await this.host.command("HSET", [
      this.keys.scheduleMeta + id,
      "status",
      "active",
      "nextRunAt",
      String(nextRunAt),
    ]);
    await this.host.command("ZADD", [
      this.keys.schedules,
      String(nextRunAt),
      id,
    ]);
    return nextRunAt;
  }

  async remove(id: string): Promise<void> {
    if (!(await this.get(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.host.command("ZREM", [this.keys.schedules, id]);
    await this.host.command("DEL", [this.keys.scheduleMeta + id]);
  }

  async tick(): Promise<void> {
    const now = Date.now();
    const raw = await this.host.command("ZRANGEBYSCORE", [
      this.keys.schedules,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      "20",
    ]);
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    for (const id of ids) {
      const values = await this.host.command("HMGET", [
        this.keys.scheduleMeta + id,
        "jobName",
        "cron",
        "timezone",
        "status",
        "nextRunAt",
        "input",
        "catchUp",
        "submit",
      ]);
      if (!Array.isArray(values) || values[0] === null) {
        await this.host.command("ZREM", [this.keys.schedules, id]);
        continue;
      }
      if (String(values[3]) !== "active") {
        await this.host.command("ZREM", [this.keys.schedules, id]);
        continue;
      }

      const jobName = String(values[0]);
      const cron = String(values[1]);
      const timezone = String(values[2]);
      const occurrence = Number(values[4]);
      const input = decode(String(values[5]));
      const catchUp = String(values[6]) === "1";
      const submit = decode(String(values[7])) as RedisAddOptions;
      const nextRunAt = nextCronOccurrence(
        cron,
        timezone,
        catchUp ? occurrence : now
      );
      const occurrenceId = `${this.queueName}:schedule:${id}:${occurrence}`;

      let accepted = false;
      try {
        const handle = this.host.submit(jobName, input, {
          ...submit,
          id: occurrenceId,
        });
        await handle.accepted;
        accepted = true;
      } catch (cause) {
        // Another worker reached this tick first. Its submission stands, so
        // this one still advances the schedule rather than retrying forever.
        if (cause instanceof DuplicateJobIdError) {
          accepted = true;
        } else {
          this.host.emit("error", toError(cause));
        }
      }
      if (!accepted) {
        continue;
      }
      await this.host.eval(
        ADVANCE_SCHEDULE_SCRIPT,
        [this.keys.scheduleMeta, this.keys.schedules],
        [id, String(occurrence), String(nextRunAt)]
      );
    }
  }
}

class RedisScheduleHandleImpl implements RedisScheduleHandle {
  private cachedNextRunAt: number;

  constructor(
    private readonly owner: RedisSchedules,
    readonly id: string,
    nextRunAt: number
  ) {
    this.cachedNextRunAt = nextRunAt;
  }

  get nextRunAt(): number {
    return this.cachedNextRunAt;
  }

  async pause(): Promise<void> {
    await this.owner.pause(this.id);
  }

  async resume(): Promise<void> {
    this.cachedNextRunAt = await this.owner.resume(this.id);
  }

  async remove(): Promise<void> {
    await this.owner.remove(this.id);
  }

  async refresh(): Promise<RedisScheduleSnapshot> {
    const value = await this.owner.get(this.id);
    if (!value) {
      throw new Error(`Schedule "${this.id}" does not exist`);
    }
    this.cachedNextRunAt = value.nextRunAt;
    return value;
  }
}
