/**
 * Scenario 4 — Long-running report generation
 *
 * A user clicks "export" and wants a progress bar. The work is slow, so the
 * request must return immediately with a handle, progress must stream while it
 * runs, and a report that hangs must be cut off rather than held forever.
 *
 * Exercises: reportProgress, structured logs, queue event subscription,
 * per-attempt timeout, and the AbortSignal a handler receives.
 */

import { z } from "zod";
import type { Progress } from "../../src/index.js";
import { enqiu, job } from "../../src/index.js";
import { expect, heading, note, step, summary } from "./_harness.js";

heading(
  "4. Report generation",
  "progress streaming, structured logs, and a timeout that actually aborts"
);

let abortObserved = false as boolean;
const progressSeen: number[] = [];

const jobs = enqiu({
  buildReport: job({
    input: z.object({ rows: z.number() }),
    timeout: 2_000,
    run: async ({ rows }, context) => {
      context.log.info("report started", { rows });
      for (let done = 1; done <= rows; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await context.reportProgress({
          completed: done,
          total: rows,
          message: `page ${done} of ${rows}`,
        });
      }
      context.log.info("report finished");
      return { url: `/reports/${rows}.pdf` };
    },
  }),
  hangingReport: job({
    input: z.object({}),
    timeout: 120,
    run: async (_input, context) => {
      context.signal.addEventListener("abort", () => {
        abortObserved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    },
  }),
});

// A UI would push these over a WebSocket; here we just collect them.
jobs.queue.on("progress", (snapshot) => {
  progressSeen.push((snapshot.progress as Progress).completed);
});

step("submitting a 5-page report; the call returns before it runs …");
const handle = await jobs.buildReport({ rows: 5 });
expect(handle.status === "queued" || handle.status === "running",
  "the caller got a handle immediately, not a finished report");

const result = await handle.result;
expect(result.url === "/reports/5.pdf", "awaiting .result yields the report");
expect(progressSeen.length === 5, `progress streamed ${progressSeen.length} updates`);
expect(progressSeen.at(-1) === 5, "the final update reported completion");

const snapshot = await handle.refresh();
expect((snapshot.logs ?? []).length === 2, "structured logs are retained on the job");
note(`logs: ${(snapshot.logs ?? []).map((l) => `${l.level}=${l.message}`).join(", ")}`);
expect((snapshot.progress as Progress).message === "page 5 of 5", "the last progress payload persisted");

step("submitting a report that hangs …");
const stuck = await jobs.hangingReport({});
await stuck.result.catch(() => undefined);
expect(abortObserved === true, "the timeout aborted the handler's signal");
expect((await stuck.refresh()).status === "failed", "and the job settled as failed");

await jobs.worker.close({ drain: false });
summary("Scenario 4");
