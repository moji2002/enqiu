import {
  nextCronOccurrence,
  parseCron,
  validateTimeZone,
} from "./cron.js";
import type {
  ScheduleHandle,
  ScheduleSnapshot,
} from "./api.js";

interface MemorySchedule {
  id: string;
  jobName: string;
  cron: string;
  timezone: string;
  status: "active" | "paused";
  nextRunAt: number;
  input: unknown;
  catchUp: boolean;
  enqueue(input: unknown, occurrence: number): Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  revision: number;
}

export interface MemoryScheduleRegistration {
  id?: string | undefined;
  jobName: string;
  cron: string;
  timezone?: string | undefined;
  input: unknown;
  catchUp?: boolean | undefined;
  enqueue(input: unknown, occurrence: number): Promise<void>;
}

export class MemoryScheduler {
  private readonly schedules = new Map<string, MemorySchedule>();
  private closed = false;

  async upsert(
    registration: MemoryScheduleRegistration
  ): Promise<ScheduleHandle> {
    this.assertOpen();
    parseCron(registration.cron);
    const timezone = validateTimeZone(registration.timezone ?? "UTC");
    const id = registration.id?.trim() || registration.jobName;
    if (!id) {
      throw new TypeError("schedule.id must not be empty");
    }
    const existing = this.schedules.get(id);
    const now = Date.now();
    const schedule: MemorySchedule = existing ?? {
      id,
      jobName: registration.jobName,
      cron: registration.cron,
      timezone,
      status: "active",
      nextRunAt: 0,
      input: registration.input,
      catchUp: registration.catchUp ?? false,
      enqueue: registration.enqueue,
      timer: undefined,
      revision: 0,
    };
    if (existing && existing.jobName !== registration.jobName) {
      throw new Error(
        `Schedule "${id}" already belongs to job "${existing.jobName}"`
      );
    }
    schedule.cron = registration.cron;
    schedule.timezone = timezone;
    schedule.input = registration.input;
    schedule.catchUp = registration.catchUp ?? false;
    schedule.enqueue = registration.enqueue;
    schedule.nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      now
    );
    schedule.revision += 1;
    this.schedules.set(id, schedule);
    this.arm(schedule);
    return new MemoryScheduleHandle(this, id);
  }

  get(id: string): ScheduleSnapshot | undefined {
    const schedule = this.schedules.get(id);
    return schedule ? snapshot(schedule) : undefined;
  }

  pause(id: string): void {
    const schedule = this.require(id);
    schedule.status = "paused";
    schedule.revision += 1;
    clearScheduleTimer(schedule);
  }

  resume(id: string): void {
    const schedule = this.require(id);
    schedule.status = "active";
    schedule.nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      Date.now()
    );
    schedule.revision += 1;
    this.arm(schedule);
  }

  remove(id: string): void {
    const schedule = this.require(id);
    clearScheduleTimer(schedule);
    this.schedules.delete(id);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const schedule of this.schedules.values()) {
      clearScheduleTimer(schedule);
    }
  }

  private arm(schedule: MemorySchedule): void {
    clearScheduleTimer(schedule);
    if (this.closed || schedule.status !== "active") {
      return;
    }
    const revision = schedule.revision;
    const delay = Math.max(0, schedule.nextRunAt - Date.now());
    schedule.timer = setTimeout(() => {
      schedule.timer = undefined;
      void this.tick(schedule.id, revision);
    }, Math.min(delay, 2_147_483_647));
  }

  private async tick(id: string, revision: number): Promise<void> {
    const schedule = this.schedules.get(id);
    if (
      !schedule ||
      schedule.status !== "active" ||
      schedule.revision !== revision ||
      this.closed
    ) {
      return;
    }
    const occurrence = schedule.nextRunAt;
    const now = Date.now();
    schedule.nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      schedule.catchUp ? occurrence : now
    );
    schedule.revision += 1;
    this.arm(schedule);
    try {
      await schedule.enqueue(schedule.input, occurrence);
    } catch {
      // Submission failures remain observable through queue events/telemetry.
      // A schedule must continue advancing instead of creating a hot loop.
    }
  }

  private require(id: string): MemorySchedule {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    return schedule;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Scheduler is closed");
    }
  }
}

class MemoryScheduleHandle implements ScheduleHandle {
  constructor(
    private readonly owner: MemoryScheduler,
    readonly id: string
  ) {}

  get nextRunAt(): number {
    return this.owner.get(this.id)?.nextRunAt ?? 0;
  }

  async pause(): Promise<void> {
    this.owner.pause(this.id);
  }

  async resume(): Promise<void> {
    this.owner.resume(this.id);
  }

  async remove(): Promise<void> {
    this.owner.remove(this.id);
  }

  async refresh(): Promise<ScheduleSnapshot> {
    const value = this.owner.get(this.id);
    if (!value) {
      throw new Error(`Schedule "${this.id}" does not exist`);
    }
    return value;
  }
}

function snapshot(schedule: MemorySchedule): ScheduleSnapshot {
  return {
    id: schedule.id,
    jobName: schedule.jobName,
    cron: schedule.cron,
    timezone: schedule.timezone,
    status: schedule.status,
    nextRunAt: schedule.nextRunAt,
    input: schedule.input,
    catchUp: schedule.catchUp,
  };
}

function clearScheduleTimer(schedule: MemorySchedule): void {
  if (schedule.timer !== undefined) {
    clearTimeout(schedule.timer);
    schedule.timer = undefined;
  }
}
