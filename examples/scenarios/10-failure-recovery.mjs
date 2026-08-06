/**
 * Scenario 10 — Failure triage and graceful shutdown
 *
 * The operational half. A dependency breaks, jobs pile up in `failed`, and once
 * it is fixed someone has to find and replay them. Separately, a deploy must
 * not drop in-flight work.
 *
 * Enqiu has no dead-letter queue: failed jobs stay queryable in place, and
 * redrive() replays them. Whether that is enough at scale is untested — see
 * docs/use-case-research.md.
 *
 * Exercises: querying by terminal status, redrive(), telemetry, and the
 * difference between a draining close and an abrupt one.
 */

import { z } from "zod";
import { enqiu, job } from "../../dist/index.js";
import { expect, heading, note, sleep, step, summary } from "./_harness.mjs";

heading(
  "10. Failure triage and shutdown",
  "find what broke, replay it, and deploy without dropping work"
);

let dependencyUp = false;
const delivered = [];
const telemetry = [];

const jobs = enqiu(
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
  {
    worker: { concurrency: 4 },
    telemetry: { emit: (event) => telemetry.push(event.type) },
  }
);

step("the banking partner is down; 4 payouts are attempted …");
const handles = await jobs.deliverPayout.bulk(
  Array.from({ length: 4 }, (_, i) => ({ payoutId: `po-${i}` }))
);
await Promise.all(handles.map((h) => h.result.catch(() => undefined)));
await jobs.worker.onIdle();

const failedPage = await jobs.queue.list({ status: "failed", limit: 100 });
expect(failedPage.jobs.length === 4, "all 4 payouts are queryable in `failed`");
expect(delivered.length === 0, "and none of them reached the partner");
note(`failure recorded: ${failedPage.jobs[0].error.message}`);
expect(telemetry.includes("job.retry"), "telemetry saw the retries");
expect(telemetry.includes("job.failed"), "and the eventual failures");

step("the partner comes back; an operator replays the batch …");
dependencyUp = true;
const replayed = await Promise.all(
  failedPage.jobs.map((snapshot) => jobs.queue.redrive(snapshot.id))
);
await Promise.all(replayed.map((h) => h.result));
await jobs.worker.onIdle();

expect(delivered.length === 4, "all 4 payouts delivered on replay");
expect((await jobs.queue.stats()).failed === 0, "nothing is left in `failed`");
expect((await jobs.queue.stats()).succeeded === 4, "and they now read as succeeded");

step("a deploy arrives mid-flight …");
const slow = enqiu(
  {
    slowWork: job({
      input: z.object({ n: z.number() }),
      run: async ({ n }) => {
        await sleep(40);
        return n;
      },
    }),
  },
  { worker: { concurrency: 2 } }
);
const inFlight = await slow.slowWork.bulk([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
// The default drains: queued work finishes before the process exits.
await slow.worker.close();
const finished = await Promise.all(inFlight.map((h) => h.refresh()));
expect(
  finished.every((snapshot) => snapshot.status === "succeeded"),
  "a draining close() let every queued job finish"
);

const abrupt = enqiu(
  { slowWork: job({ input: z.object({ n: z.number() }), run: async ({ n }) => { await sleep(200); return n; } }) },
  { worker: { concurrency: 1 } }
);
const dropped = await abrupt.slowWork.bulk([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
await abrupt.worker.close({ drain: false });
const after = await Promise.all(dropped.map((h) => h.refresh()));
expect(
  after.some((snapshot) => snapshot.status === "cancelled"),
  "close({ drain: false }) cancelled the outstanding work instead"
);
note("drain for deploys; drain:false only when you are discarding the work.");

await jobs.worker.close();
summary("Scenario 10");
