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
export interface ScheduleConnection {
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
  constructor(private readonly connection: ScheduleConnection) {}

  async upsertSchedule(
    registration: RedisScheduleRegistration
  ): Promise<RedisScheduleHandle> {
    this.connection.assertOpen();
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
    const result = await this.connection.eval(
      UPSERT_SCHEDULE_SCRIPT,
      [this.connection.keys.scheduleMeta, this.connection.keys.schedules],
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

  async getSchedule(
    id: string
  ): Promise<RedisScheduleSnapshot | undefined> {
    const values = await this.connection.command("HMGET", [
      this.connection.keys.scheduleMeta + id,
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

  async pauseSchedule(id: string): Promise<void> {
    if (!(await this.getSchedule(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.connection.command("HSET", [
      this.connection.keys.scheduleMeta + id,
      "status",
      "paused",
    ]);
    await this.connection.command("ZREM", [this.connection.keys.schedules, id]);
  }

  async resumeSchedule(id: string): Promise<number> {
    const schedule = await this.getSchedule(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    const nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      Date.now()
    );
    await this.connection.command("HSET", [
      this.connection.keys.scheduleMeta + id,
      "status",
      "active",
      "nextRunAt",
      String(nextRunAt),
    ]);
    await this.connection.command("ZADD", [
      this.connection.keys.schedules,
      String(nextRunAt),
      id,
    ]);
    return nextRunAt;
  }

  async removeSchedule(id: string): Promise<void> {
    if (!(await this.getSchedule(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.connection.command("ZREM", [this.connection.keys.schedules, id]);
    await this.connection.command("DEL", [this.connection.keys.scheduleMeta + id]);
  }

  async tick(): Promise<void> {
    const now = Date.now();
    const raw = await this.connection.command("ZRANGEBYSCORE", [
      this.connection.keys.schedules,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      "20",
    ]);
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    for (const id of ids) {
      const values = await this.connection.command("HMGET", [
        this.connection.keys.scheduleMeta + id,
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
        await this.connection.command("ZREM", [this.connection.keys.schedules, id]);
        continue;
      }
      if (String(values[3]) !== "active") {
        await this.connection.command("ZREM", [this.connection.keys.schedules, id]);
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
      const occurrenceId = `${this.connection.name}:schedule:${id}:${occurrence}`;

      let accepted = false;
      try {
        const handle = this.connection.submit(jobName, input, {
          ...submit,
          id: occurrenceId,
        });
        await handle.accepted;
        accepted = true;
      } catch (cause) {
        const error = toError(cause);
        if (error.message.includes(`Job ID "${occurrenceId}" already exists`)) {
          accepted = true;
        } else {
          this.connection.emit("error", error);
        }
      }
      if (!accepted) {
        continue;
      }
      await this.connection.eval(
        ADVANCE_SCHEDULE_SCRIPT,
        [this.connection.keys.scheduleMeta, this.connection.keys.schedules],
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
    await this.owner.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    this.cachedNextRunAt = await this.owner.resumeSchedule(this.id);
  }

  async remove(): Promise<void> {
    await this.owner.removeSchedule(this.id);
  }

  async refresh(): Promise<RedisScheduleSnapshot> {
    const value = await this.owner.getSchedule(this.id);
    if (!value) {
      throw new Error(`Schedule "${this.id}" does not exist`);
    }
    this.cachedNextRunAt = value.nextRunAt;
    return value;
  }
}
