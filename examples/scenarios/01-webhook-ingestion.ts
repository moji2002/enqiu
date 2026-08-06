/**
 * Scenario 1 — Webhook ingestion (Stripe/GitHub shape)
 *
 * Providers deliver at-least-once, so the same event arrives more than once and
 * the consumer owns idempotency. Transient failures should back off; permanent
 * ones (a 4xx) should fail immediately rather than burn four retries.
 *
 * Exercises: idempotencyKey, exponential backoff with jitter, a `when`
 * predicate, and the failed terminal state.
 */

import { z } from "zod";
import { job } from "../../src/index.js";
import {
  backends,
  type Backend,
  driverOptions,
  expect,
  heading,
  makeJobs,
  note,
  step,
  summary,
} from "./_harness.js";

class PermanentError extends Error {}

async function run(backend: Backend) {
  heading(
    `1. Webhook ingestion  (${backend})`,
    "at-least-once delivery means duplicates are the provider's normal behaviour"
  );

  const handled = [];
  let attemptsForFlaky = 0;

  const driver = await driverOptions(
    backend === "redis" ? process.env.ENQIU_TEST_REDIS_URL : undefined,
    `enqiu-scenario-1:${Date.now()}`
  );

  const jobs = makeJobs(
    {
      handleWebhook: job({
        input: z.object({ eventId: z.string(), type: z.string() }),
        retry: {
          attempts: 4,
          // Jitter spreads a provider outage's retries instead of stampeding.
          backoff: { type: "exponential", delay: 20, jitter: 0.3 },
          when: (error) => !(error instanceof PermanentError),
        },
        run: async ({ eventId, type }) => {
          if (type === "malformed") {
            throw new PermanentError("422 unprocessable");
          }
          if (type === "flaky") {
            attemptsForFlaky += 1;
            if (attemptsForFlaky < 3) throw new Error("503 upstream");
          }
          handled.push(eventId);
          return { eventId };
        },
      }),
    },
    driver
  );

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

  expect(replay.id === first.id, "redelivery returns the original job handle");
  expect(replay.deduplicated === true, "the duplicate is flagged, not re-run");
  expect(handled.length === 1, "the handler ran exactly once for evt_1");

  step("a flaky upstream returns 503 twice, then succeeds …");
  const flaky = await jobs.handleWebhook(
    { eventId: "evt_2", type: "flaky" },
    { idempotencyKey: "evt_2" }
  );
  await flaky.result;
  expect(attemptsForFlaky === 3, "retried with backoff until it succeeded");

  if (backend === "memory") {
    step("a malformed event is rejected permanently …");
    const bad = await jobs.handleWebhook(
      { eventId: "evt_3", type: "malformed" },
      { idempotencyKey: "evt_3" }
    );
    await bad.result.catch(() => undefined);
    const snapshot = await bad.refresh();
    expect(snapshot.status === "failed", "a 4xx lands in `failed`");
    expect(snapshot.attempt === 1, "`when` stopped it retrying a permanent error");
  } else {
    note("skipped: `when` is a function, so it cannot cross into Redis —");
    note("the Redis driver accepts only the serialisable part of a policy.");
  }

  await jobs.worker.close();
  await driver.close();
  summary(`Scenario 1 (${backend})`);
}

for (const backend of backends()) {
  await run(backend);
}
