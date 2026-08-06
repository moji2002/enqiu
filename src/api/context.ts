/** Builds the JobContext a handler sees, over the driver's raw context. */

import { cloneJobValue } from "../codec.js";
import type {
  AddOptions,
  JobContext as HandlerContext,
  JobSnapshot,
  JobStatus,
  KeyedConcurrencyOptions,
  MaybePromise,
  QueueEventMap,
  QueueStats,
  RetryOptions,
} from "../memory.js";
import type {
  DriverFactory,
  DriverHandlers,
  DriverJob,
  DriverQueueOptions,
  QueueDriver,
  ScheduleHandle,
} from "../driver.js";
import type {
  JobContext,
  JobLogger,
  Progress,
  Telemetry,
} from "./types.js";

export function createContext(
  handler: HandlerContext,
  queue: string,
  telemetry: Telemetry | undefined
): JobContext {
  const log = createLogger(handler, queue, telemetry);
  return {
    id: handler.id,
    name: handler.name,
    attempt: handler.attempt,
    signal: handler.signal,
    reportProgress: async (progress: Progress) => {
      validateProgress(progress);
      const safeProgress = cloneJobValue(progress);
      handler.progress(safeProgress);
      telemetry?.emit({
        type: "job.progress",
        queue,
        timestamp: Date.now(),
        fields: {
          jobId: handler.id,
          jobName: handler.name,
          progress: safeProgress,
        },
      });
    },
    log,
  };
}

export function createLogger(
  context: HandlerContext,
  queue: string,
  telemetry: Telemetry | undefined
): JobLogger {
  const write = (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    fields?: Readonly<Record<string, unknown>>
  ): void => {
    if (!message) {
      throw new TypeError("Job log messages must not be empty");
    }
    const entry = cloneJobValue({
      timestamp: Date.now(),
      level,
      message,
      ...(fields === undefined ? {} : { fields }),
    });
    context.log(entry);
    telemetry?.emit({
      type: `job.log.${level}`,
      queue,
      timestamp: Date.now(),
      fields: {
        jobId: context.id,
        jobName: context.name,
        message: entry.message,
        ...(entry.fields ?? {}),
      },
    });
  };
  return Object.freeze({
    debug: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("debug", message, fields),
    info: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("info", message, fields),
    warn: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("warn", message, fields),
    error: (
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ) => write("error", message, fields),
  });
}

export function validateProgress(progress: Progress): void {
  if (
    !Number.isFinite(progress.completed) ||
    !Number.isFinite(progress.total) ||
    progress.completed < 0 ||
    progress.total <= 0 ||
    progress.completed > progress.total
  ) {
    throw new RangeError(
      "Progress requires 0 <= completed <= total and total > 0"
    );
  }
}

