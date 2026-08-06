/**
 * Scenario 8 — LLM / GPU inference orchestration
 *
 * Inference capacity is per model, not global: two GPUs serving model-a says
 * nothing about model-b. Requests are long and occasionally hang, so every call
 * needs a deadline. Queue depth is the backpressure signal an API layer reads
 * to decide whether to shed load.
 *
 * Exercises: concurrency keyed by model as a GPU-slot pool, per-job timeout
 * with signal propagation, queue depth as backpressure, and pausing the queue
 * for maintenance.
 */

import { z } from "zod";
import { enqiu, job } from "../../src/index.js";
import { expect, heading, note, sleep, step, summary } from "./_harness.js";

heading(
  "8. Inference orchestration",
  "GPU slots per model, deadlines on every call, queue depth as backpressure"
);

const slots = new Map();
const peak = new Map();
let cancelledMidFlight = false as boolean;

const jobs = enqiu(
  {
    infer: job({
      input: z.object({ model: z.string(), prompt: z.string() }),
      // Two slots per model; models do not share a budget.
      concurrency: { limit: 2, by: (input) => input.model },
      timeout: 1_000,
      run: async ({ model }) => {
        const current = (slots.get(model) ?? 0) + 1;
        slots.set(model, current);
        peak.set(model, Math.max(peak.get(model) ?? 0, current));
        await sleep(30);
        // Decrement the current value; `current - 1` would race.
        slots.set(model, (slots.get(model) ?? 1) - 1);
        return { model, tokens: 128 };
      },
    }),
    runawayInfer: job({
      input: z.object({}),
      timeout: 80,
      run: async (_input, context) => {
        context.signal.addEventListener("abort", () => {
          cancelledMidFlight = true;
        });
        await sleep(5_000);
      },
    }),
  },
  { worker: { concurrency: 16 } }
);

step("12 requests across two models arrive at once …");
await Promise.all([
  ...Array.from({ length: 6 }, (_, i) =>
    jobs.infer({ model: "sonnet", prompt: `p${i}` })
  ),
  ...Array.from({ length: 6 }, (_, i) =>
    jobs.infer({ model: "opus", prompt: `p${i}` })
  ),
]);
await jobs.worker.onIdle();

expect(peak.get("sonnet") <= 2, `sonnet stayed within its 2 slots (peak ${peak.get("sonnet")})`);
expect(peak.get("opus") <= 2, `opus stayed within its 2 slots (peak ${peak.get("opus")})`);
note("a saturated model does not starve another — the slots are per key.");

step("a request hangs past its deadline …");
const runaway = await jobs.runawayInfer({});
await runaway.result.catch(() => undefined);
expect(cancelledMidFlight === true, "the deadline aborted the in-flight request");
note("handlers get an AbortSignal — pass it to fetch() and the socket closes too.");

step("draining for GPU maintenance …");
await jobs.queue.pause();
await jobs.infer.bulk(
  Array.from({ length: 5 }, (_, i) => ({ model: "sonnet", prompt: `queued-${i}` }))
);
const depth = (await jobs.queue.stats()).queued;
expect(depth === 5, `queue depth is ${depth} — the signal an API layer sheds load on`);

await jobs.queue.resume();
await jobs.worker.onIdle();
expect((await jobs.queue.stats()).queued === 0, "the backlog drained after resume");

await jobs.worker.close();
summary("Scenario 8");
