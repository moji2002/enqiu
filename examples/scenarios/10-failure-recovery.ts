/**
 * Scenario 10 — Failure triage and graceful shutdown
 *
 * A dependency breaks, jobs pile up in `failed`, and once it is fixed someone
 * has to find and replay them. Separately, a deploy must not drop queued work.
 *
 * Exercises: querying by terminal status, redrive(), telemetry, and the
 * difference between a draining close and an abrupt one.
 */

import { z } from "zod";
import { job } from "../../src/index.js";
import { expect, heading, makeJobs, note, sleep, step, summary } from "./_harness.js";

heading(
  "10. Failure triage and shutdown",
  "find what broke, replay it, and deploy without dropping work"
);

let dependencyUp = false;
const delivered: string[] = [];
const telemetry: string[] = [];

const jobs = makeJobs(
  {
    deliverPayout: job({
      input: z.object({ payoutId: z.string() }),
      retry: { attempts: 2, backoff: 10 },
      run: async ({ payoutId }) => {
        if (!dependencyUp) throw new Error("banking partner unreachable");
        delivered.push(payoutId);
        return { payoutId };
      },
    }),
  },
  { telemetry: { emit: (event) => telemetry.push(event.type) } }
);

step("the banking partner is down; 4 payouts are attempted …");
const handles = await jobs.deliverPayout.bulk(
  Array.from({ length: 4 }, (_, i) => ({ payoutId: `po-${i}` }))
);
await Promise.all(handles.map((h) => h.result.catch(() => undefined)));

const failed = await jobs.queue.list({ status: "failed", limit: 100 });
expect(failed.jobs.length === 4, "all 4 payouts are queryable in `failed`");
expect(delivered.length === 0, "and none reached the partner");
note(`failure recorded: ${failed.jobs[0]?.error?.message ?? "unknown"}`);

step("the partner comes back; an operator replays the batch …");
dependencyUp = true;
for (const snapshot of failed.jobs) {
  await jobs.queue.redrive(snapshot.id);
}
await jobs.worker.onIdle();
expect(delivered.length === 4, "all 4 payouts delivered on replay");
expect((await jobs.queue.stats()).failed === 0, "nothing is left in `failed`");

step("a deploy arrives mid-flight …");
const done: number[] = [];
const slow = makeJobs({
  slowWork: job({
    input: z.object({ n: z.number() }),
    run: async ({ n }) => {
      await sleep(30);
      done.push(n);
      return n;
    },
  }),
});
await slow.slowWork.bulk([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
// The default drains: queued work finishes before close() resolves. Counting
// in the handler rather than refreshing afterwards, because close() takes the
// connection with it.
await slow.worker.close();
expect(done.length === 4, "a draining close() let every queued job finish");
note("drain for deploys; drain:false only when you are discarding the work.");

await jobs.worker.close({ drain: false });
summary("Scenario 10");
process.exit(0);
