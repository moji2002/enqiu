/**
 * Running one job: expiry, the per-attempt deadline, and the handler's context.
 *
 * These are the two policies Enqiu enforces itself, because BullMQ has neither
 * and both cost nothing to add around the handler. Everything else about
 * execution — claiming, retrying, stalling, locking — is BullMQ's.
 */

import { UnrecoverableError, type Job as BullJob } from "bullmq";
import { JobTimeoutError, encodeFailure } from "./errors.js";
import { assertJobValue } from "./serialize.js";
import type { RuntimeDefinition } from "./definition.js";
import type {
  JobContext,
  JobLogger,
  Progress,
  TelemetrySink,
} from "./types.js";

export interface RunnerOptions {
  readonly queueName: string;
  /** Queue-wide deadline, overridden per job. */
  readonly timeout: number | undefined;
  readonly telemetry: TelemetrySink | undefined;
}

/** For handlers with no deadline, whose only abort source is BullMQ's own. */
const neverAborts = new AbortController().signal;

function validateProgress(progress: Progress): void {
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

export class JobRunner {
  constructor(
    private readonly definitions: ReadonlyMap<string, RuntimeDefinition>,
    private readonly options: RunnerOptions
  ) {}

  async run(bull: BullJob, external?: AbortSignal): Promise<unknown> {
    const id = String(bull.id);
    const definition = this.definitions.get(bull.name);
    if (!definition) {
      throw new UnrecoverableError(
        `No handler registered for job "${bull.name}"`
      );
    }

    const { expiresIn } = definition.policy;
    if (expiresIn !== undefined && Date.now() - bull.timestamp > expiresIn) {
      // Expiry is a property of the job, not of this attempt, so retrying
      // cannot help — UnrecoverableError stops BullMQ retrying it.
      throw new UnrecoverableError(encodeFailure({ kind: "expired", jobId: id }));
    }

    const timeout = definition.policy.timeout ?? this.options.timeout;
    if (timeout === undefined) {
      // BullMQ's signal already aborts on cancellation, and with no deadline to
      // merge in there is nothing left for a second controller to do.
      const context = this.createContext(bull, external ?? neverAborts);
      return assertJobValue(await definition.run(bull.data, context));
    }

    // One signal for the handler, whichever reason fires first: this queue's
    // own deadline, or a cancellation delivered through BullMQ.
    const controller = new AbortController();
    if (external) {
      if (external.aborted) {
        controller.abort(external.reason);
      } else {
        external.addEventListener(
          "abort",
          () => controller.abort(external.reason),
          { once: true }
        );
      }
    }
    const execution = Promise.resolve(
      definition.run(bull.data, this.createContext(bull, controller.signal))
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return assertJobValue(
        await Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // The handler is told what happened; BullMQ is told in a form
              // that survives being stored as a single string.
              controller.abort(new JobTimeoutError(id, timeout));
              reject(new Error(encodeFailure({ kind: "timeout", jobId: id, timeout })));
            }, timeout);
          }),
        ])
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private createContext(bull: BullJob, signal: AbortSignal): JobContext {
    const queue = this.options.queueName;
    const telemetry = this.options.telemetry;
    const write = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ): void => {
      if (!message) throw new TypeError("Job log messages must not be empty");
      void bull
        .log(JSON.stringify({ level, message, fields, at: Date.now() }))
        .catch(() => undefined);
      telemetry?.emit({
        type: `job.log.${level}`,
        queue,
        timestamp: Date.now(),
        fields: { jobId: String(bull.id), jobName: bull.name, message },
      });
    };
    const log: JobLogger = {
      debug: (m, f) => write("debug", m, f),
      info: (m, f) => write("info", m, f),
      warn: (m, f) => write("warn", m, f),
      error: (m, f) => write("error", m, f),
    };

    return {
      id: String(bull.id),
      name: bull.name,
      attempt: bull.attemptsMade + 1,
      signal,
      log,
      reportProgress: async (progress: Progress) => {
        validateProgress(progress);
        await bull.updateProgress(assertJobValue(progress) as never);
        telemetry?.emit({
          type: "job.progress",
          queue,
          timestamp: Date.now(),
          fields: { jobId: String(bull.id), progress },
        });
      },
    };
  }
}
