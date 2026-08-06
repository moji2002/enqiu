/**
 * Scenario 9 — High-volume sensor ingestion
 *
 * Volume is the whole problem. Readings arrive faster than the downstream sink
 * accepts them, and an unbounded history of finished jobs is a memory leak that
 * looks like a working system until it isn't.
 *
 * Exercises: bulk submission at volume, a throttle that protects the sink,
 * historyLimit as a bounded retention window, list() pagination, and cleanup().
 */

import { z } from "zod";
import { enqiu, job } from "../../dist/index.js";
import { expect, heading, note, step, summary } from "./_harness.mjs";

heading(
  "9. Sensor ingestion",
  "volume, a protected sink, and history that stays bounded"
);

let written = 0;

const jobs = enqiu(
  {
    ingestReading: job({
      input: z.object({ deviceId: z.string(), celsius: z.number() }),
      // The sink accepts 200/sec with a burst of 200; readings exceed that.
      throttle: { limit: 200, per: 1_000, burst: 200, by: () => "sink" },
      run: async () => {
        written += 1;
      },
    }),
  },
  {
    // Retain only the last 50 finished jobs. Without this, a queue that has
    // processed millions holds every one of them.
    historyLimit: 50,
    worker: { concurrency: 32 },
  }
);

step("500 readings arrive in one batch …");
const started = Date.now();
await jobs.ingestReading.bulk(
  Array.from({ length: 500 }, (_, i) => ({
    deviceId: `sensor-${i % 20}`,
    celsius: 20 + (i % 15),
  }))
);
await jobs.worker.onIdle();
const elapsed = Date.now() - started;

expect(written === 500, "every reading was written to the sink");
note(`ingested 500 readings in ${elapsed}ms`);

const stats = await jobs.queue.stats();
expect(stats.total <= 50, `history stayed bounded at ${stats.total} of 500 processed`);
note("historyLimit is what stops a long-lived queue growing without limit.");

step("walking the retained window with a cursor …");
let seen = 0;
let cursor;
let pages = 0;
do {
  const page = await jobs.queue.list(cursor ? { limit: 20, cursor } : { limit: 20 });
  seen += page.jobs.length;
  cursor = page.cursor;
  pages += 1;
} while (cursor && pages < 10);

expect(seen === stats.total, `paginated through all ${seen} retained jobs in ${pages} pages`);

step("clearing the window explicitly …");
const removed = await jobs.queue.cleanup({ status: "succeeded" });
expect(removed.length === stats.total, `cleanup() removed ${removed.length} finished jobs`);
expect((await jobs.queue.stats()).total === 0, "the queue is empty afterwards");

await jobs.worker.close();
summary("Scenario 9");
