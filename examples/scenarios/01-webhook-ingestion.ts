/**
 * Scenario 1 — Webhook ingestion
 *
 * Providers deliver at-least-once, so the same event arrives more than once
 * and the consumer owns idempotency. Transient failures back off and retry.
 *
 * Exercises: idempotencyKey (BullMQ deduplication), attempts + backoff.
 */

import { z } from "zod";
import { job } from "../../src/index.js";
import { expect, finish, heading, makeJobs, step } from "./_harness.js";

heading(
  "1. Webhook ingestion",
  "at-least-once delivery means duplicates are the provider's normal behaviour"
);

const handled: string[] = [];
let flakyAttempts = 0;

const jobs = makeJobs({
  handleWebhook: job({
    input: z.object({ eventId: z.string(), type: z.string() }),
    retry: { attempts: 4, backoff: { type: "exponential", delay: 20 } },
    run: async ({ eventId, type }) => {
      if (type === "flaky") {
        flakyAttempts += 1;
        if (flakyAttempts < 3) throw new Error("503 upstream");
      }
      handled.push(eventId);
      return { eventId };
    },
  }),
});

step("provider delivers evt_1 …");
const first = await jobs.handleWebhook(
  { eventId: "evt_1", type: "payment" },
  { idempotencyKey: "evt_1", idempotencyTtl: 60_000 }
);
await first.result;

step("provider redelivers the same evt_1 …");
const replay = await jobs.handleWebhook(
  { eventId: "evt_1", type: "payment" },
  { idempotencyKey: "evt_1", idempotencyTtl: 60_000 }
);
expect(replay.deduplicated === true, "the duplicate is flagged, not re-run");
expect(handled.length === 1, "the handler ran exactly once for evt_1");

step("a flaky upstream returns 503 twice, then succeeds …");
const flaky = await jobs.handleWebhook({ eventId: "evt_2", type: "flaky" });
await flaky.result;
expect(flakyAttempts === 3, "retried with backoff until it succeeded");
expect((await flaky.refresh()).status === "succeeded", "and settled as succeeded");

await finish("Scenario 1", jobs);
