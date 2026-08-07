/**
 * What Enqiu reports, and the shape it reports it in.
 *
 * The emit sites stay where the things they describe happen — telemetry is
 * cross-cutting, and centralising *when* an event fires would be worse than
 * the scattering it cured. What lives here is the vocabulary: the names of the
 * events, and the envelope every one of them arrives in. Adding an event used
 * to mean knowing which of two files to open and rebuilding `{ type, queue,
 * timestamp, fields }` by hand at the fifth call site.
 */

import type { Worker } from "bullmq";
import type { TelemetrySink } from "./types.js";

export class Telemetry {
  constructor(
    private readonly sink: TelemetrySink | undefined,
    private readonly queue: string
  ) {}

  private emit(type: string, fields: Record<string, unknown>): void {
    this.sink?.emit({ type, queue: this.queue, timestamp: Date.now(), fields });
  }

  jobLog(
    level: "debug" | "info" | "warn" | "error",
    fields: { jobId: string; jobName: string; message: string }
  ): void {
    this.emit(`job.log.${level}`, fields);
  }

  jobProgress(jobId: string, progress: unknown): void {
    this.emit("job.progress", { jobId, progress });
  }

  jobCancelled(jobId: string, reason: string): void {
    this.emit("job.cancelled", { jobId, reason });
  }

  /**
   * Forward the worker's own lifecycle.
   *
   * Without this a sink sees only what Enqiu does — logs, progress,
   * cancellations — and never a completion or a failure, which is what anyone
   * wiring one up came for.
   *
   * Note the `error` listener. BullMQ emits `error` for Redis trouble, and an
   * EventEmitter with no `error` listener throws; attaching one only when a
   * sink exists means configuring telemetry changes that. That is deliberate:
   * swallowing Redis errors on everyone's behalf would be the worse default.
   */
  observe(worker: Worker): void {
    if (!this.sink) return;
    worker.on("completed", (bull) => {
      this.emit("job.succeeded", {
        jobId: String(bull.id),
        jobName: bull.name,
      });
    });
    worker.on("failed", (bull, error) => {
      this.emit("job.failed", {
        jobId: bull ? String(bull.id) : undefined,
        jobName: bull?.name,
        message: error.message,
      });
    });
    worker.on("stalled", (jobId) => this.emit("job.stalled", { jobId }));
    worker.on("error", (error) =>
      this.emit("worker.error", { message: error.message })
    );
  }
}
