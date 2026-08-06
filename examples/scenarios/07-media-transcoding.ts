/**
 * Scenario 7 — Media transcoding pool
 *
 * Transcoding is CPU-bound, so the pool size is a resource decision, not a
 * throughput preference. Paid uploads should not wait behind a free-tier
 * backlog, and the pool needs to be resizable without a redeploy.
 *
 * Exercises: a global worker pool cap, priority tiers across a backlog, live
 * progress on long jobs, and queue.setConcurrency() at runtime.
 */

import { z } from "zod";
import type { Progress } from "../../src/index.js";
import { enqiu, job } from "../../src/index.js";
import { expect, heading, note, step, summary } from "./_harness.js";

heading(
  "7. Media transcoding pool",
  "a bounded CPU pool, priority for paid uploads, resizable at runtime"
);

const order: string[] = [];
let concurrent = 0;
let peak = 0;
const progressByJob = new Map();

const jobs = enqiu(
  {
    transcode: job({
      input: z.object({ asset: z.string(), tier: z.string() }),
      run: async ({ asset }, context) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        order.push(asset);
        for (let done = 1; done <= 3; done += 1) {
          await new Promise((resolve) => setTimeout(resolve, 8));
          await context.reportProgress({ completed: done, total: 3 });
        }
        concurrent -= 1;
        return { asset };
      },
    }),
  },
  { worker: { concurrency: 2, autoStart: false } }
);

jobs.queue.on("progress", (snapshot) => {
  progressByJob.set(snapshot.id, (snapshot.progress as Progress).completed);
});

step("a free-tier backlog of 6 uploads arrives …");
await jobs.transcode.bulk(
  Array.from({ length: 6 }, (_, i) => ({ asset: `free-${i}`, tier: "free" })),
  { priority: "low" }
);

step("then two paid uploads arrive behind it …");
await jobs.transcode({ asset: "paid-0", tier: "paid" }, { priority: "high" });
await jobs.transcode({ asset: "paid-1", tier: "paid" }, { priority: "high" });

const queued = (await jobs.queue.stats()).queued;
expect(queued === 8, `8 uploads are waiting on a pool of 2 (queued=${queued})`);

await jobs.worker.start();
await jobs.worker.onIdle();

expect(peak <= 2, `the pool never exceeded 2 concurrent transcodes (peak ${peak})`);
expect(
  order.slice(0, 2).every((asset) => asset.startsWith("paid-")),
  "both paid uploads ran before the free backlog, despite arriving later"
);
expect(progressByJob.size === 8, "progress streamed for every asset");
expect(
  [...progressByJob.values()].every((completed) => completed === 3),
  "and each one reached 3 of 3"
);

step("scaling the pool up at runtime …");
await jobs.queue.setConcurrency(6);
peak = 0;
await jobs.transcode.bulk(
  Array.from({ length: 6 }, (_, i) => ({ asset: `burst-${i}`, tier: "paid" }))
);
await jobs.worker.onIdle();
expect(peak > 2, `the resized pool ran ${peak} at once without a restart`);
note("pool size is a resource decision — size it to cores, not to demand.");

await jobs.worker.close();
summary("Scenario 7");
