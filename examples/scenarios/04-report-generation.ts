/**
 * Scenario 4 — Long-running report generation
 *
 * The request returns immediately with a handle, progress streams while the
 * work runs, and a report that hangs is cut off rather than held forever.
 *
 * Exercises: reportProgress, structured logs, and the per-attempt timeout
 * Enqiu enforces itself — BullMQ has no job timeout of its own.
 */

import { z } from "zod";
import { job } from "../../src/index.js";
import {
  expect,
  expectRejects,
  finish,
  heading,
  makeJobs,
  note,
  step,
} from "./_harness.js";

heading(
  "4. Report generation",
  "progress, structured logs, and a timeout that actually aborts"
);

let abortObserved = false as boolean;

const jobs = makeJobs({
  buildReport: job({
    input: z.object({ rows: z.number() }),
    timeout: 5_000,
    run: async ({ rows }, context) => {
      context.log.info("report started", { rows });
      for (let done = 1; done <= rows; done += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
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
    timeout: 100,
    run: async (_input, context) => {
      context.signal.addEventListener("abort", () => {
        abortObserved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    },
  }),
});

step("submitting a 5-page report; the call returns before it runs …");
const handle = await jobs.buildReport({ rows: 5 });
expect(handle.status === "queued", "the caller got a handle, not a finished report");

const result = await handle.result;
expect(result.url === "/reports/5.pdf", "awaiting .result yields the report");

const snapshot = await handle.refresh();
expect(
  (snapshot.progress as { completed: number }).completed === 5,
  "the final progress update persisted"
);
note(`progress: ${JSON.stringify(snapshot.progress)}`);

step("submitting a report that hangs …");
const stuck = await jobs.hangingReport({});
await expectRejects(stuck.result, "a hung report rejects rather than hanging on");
expect(abortObserved === true, "the timeout aborted the handler's signal");
expect((await stuck.refresh()).status === "failed", "and the job settled as failed");

await finish("Scenario 4", jobs, { drain: false });
