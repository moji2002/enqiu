/**
 * Scenario 6 — E-commerce order processing
 *
 * The hard requirement is not throughput, it is that two events for the SAME
 * order never run concurrently — otherwise inventory is decremented twice or a
 * refund races a capture. Different orders should still run in parallel.
 *
 * Exercises: keyed concurrency of 1 as a per-entity lock, plus an idempotency
 * key so a retried checkout does not charge twice.
 */

import { z } from "zod";
import { enqiu, job } from "../../src/index.js";
import { expect, heading, step, summary } from "./_harness.js";

heading(
  "6. Order processing",
  "concurrency limit 1 keyed by order id is a per-entity lock"
);

const ledger: string[] = [];
const inFlight = new Map();
let overlaps = 0;

const jobs = enqiu(
  {
    processOrderEvent: job({
      input: z.object({ orderId: z.string(), event: z.string() }),
      // One at a time per order; unrelated orders are unaffected.
      concurrency: { limit: 1, by: (input) => input.orderId },
      run: async ({ orderId, event }) => {
        if ((inFlight.get(orderId) ?? 0) > 0) overlaps += 1;
        inFlight.set(orderId, (inFlight.get(orderId) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        ledger.push(`${orderId}:${event}`);
        inFlight.set(orderId, inFlight.get(orderId) - 1);
        return { orderId, event };
      },
    }),
    chargeCard: job({
      input: z.object({ orderId: z.string(), amount: z.number() }),
      run: async ({ orderId, amount }) => {
        ledger.push(`charged:${orderId}:${amount}`);
        return { captured: amount };
      },
    }),
  },
  { worker: { concurrency: 12 } }
);

step("three events land for order-1 and order-2 simultaneously …");
await Promise.all([
  jobs.processOrderEvent({ orderId: "order-1", event: "reserve" }),
  jobs.processOrderEvent({ orderId: "order-1", event: "capture" }),
  jobs.processOrderEvent({ orderId: "order-1", event: "fulfil" }),
  jobs.processOrderEvent({ orderId: "order-2", event: "reserve" }),
  jobs.processOrderEvent({ orderId: "order-2", event: "capture" }),
  jobs.processOrderEvent({ orderId: "order-2", event: "fulfil" }),
]);
await jobs.worker.onIdle();

expect(overlaps === 0, "no two events for one order ever overlapped");
expect(ledger.length === 6, "all six events were processed");

const orderOne = ledger.filter((e) => e.startsWith("order-1"));
expect(
  orderOne.join(",") === "order-1:reserve,order-1:capture,order-1:fulfil",
  "and they stayed in submission order within the order"
);

step("the checkout request is retried by an impatient browser …");
const first = await jobs.chargeCard(
  { orderId: "order-9", amount: 4200 },
  { idempotencyKey: "checkout-order-9", idempotencyTtl: 3_600_000 }
);
const retry = await jobs.chargeCard(
  { orderId: "order-9", amount: 4200 },
  { idempotencyKey: "checkout-order-9", idempotencyTtl: 3_600_000 }
);
await first.result;

expect(retry.id === first.id, "the duplicate checkout mapped to the same job");
expect(
  ledger.filter((e) => e.startsWith("charged:")).length === 1,
  "the card was charged exactly once"
);

await jobs.worker.close();
summary("Scenario 6");
