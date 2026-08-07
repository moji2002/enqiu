/**
 * Scenario 7 — Media transcoding pool
 *
 * Transcoding is CPU-bound, so the pool size is a resource decision. Paid
 * uploads should not wait behind a free-tier backlog.
 *
 * Exercises: a bounded worker pool, priority across a backlog, live progress.
 */

import { z } from "zod";
import { job } from "../../src/index.js";
import {
  expect,
  finish,
  heading,
  makeJobs,
  note,
  sleep,
  step,
} from "./_harness.js";

heading(
  "7. Media transcoding pool",
  "a bounded pool, priority for paid uploads, progress on long jobs"
);

const order: string[] = [];
let concurrent = 0;
let peak = 0;

const { jobs, queue, worker, close } = makeJobs(
  {
    transcode: job({
      input: z.object({ asset: z.string(), tier: z.string() }),
      run: async ({ asset }, context) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        order.push(asset);
        for (let done = 1; done <= 3; done += 1) {
          await sleep(5);
          await context.reportProgress({ completed: done, total: 3 });
        }
        concurrent -= 1;
        return { asset };
      },
    }),
  },
  { worker: { concurrency: 2, autoStart: false } }
);

step("a free-tier backlog of 6 uploads arrives …");
await jobs.transcode.bulk(
  Array.from({ length: 6 }, (_, i) => ({ asset: `free-${i}`, tier: "free" })),
  { priority: "low" }
);

step("then two paid uploads arrive behind it …");
await Promise.all([
  jobs.transcode({ asset: "paid-0", tier: "paid" }, { priority: "high" }),
  jobs.transcode({ asset: "paid-1", tier: "paid" }, { priority: "high" }),
]);

expect((await queue.stats()).queued === 8, "8 uploads wait on a pool of 2");

await worker.start();
await queue.onIdle();

expect(peak <= 2, `the pool never exceeded 2 concurrent transcodes (peak ${peak})`);
expect(
  order.slice(0, 2).every((asset) => asset.startsWith("paid-")),
  "both paid uploads ran before the free backlog, despite arriving later"
);
note("pool size is a resource decision — size it to cores, not to demand.");

await finish("Scenario 7", close, { drain: false });
