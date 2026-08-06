/**
 * Scenario 2 — Multi-tenant sync against a rate-limited third-party API
 *
 * Production systems layer two limiters: a request-rate cap and a concurrency
 * cap. They are different mechanisms — one meters starts over time, the other
 * caps simultaneous work — and both must be per tenant, or one noisy customer
 * eats a shared budget.
 *
 * Exercises: keyed concurrency and token-bucket throttle, both keyed by tenant.
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
  step,
  summary,
} from "./_harness.js";

async function run(backend: Backend) {
  heading(
    `2. Multi-tenant API sync  (${backend})`,
    "per-tenant concurrency cap AND per-tenant token bucket, together"
  );

  const active = new Map();
  const peak = new Map();

  const driver = await driverOptions(
    backend === "redis" ? process.env.ENQIU_TEST_REDIS_URL : undefined,
    `enqiu-scenario-2:${Date.now()}`
  );

  const jobs = makeJobs(
    {
      syncAccount: job({
        input: z.object({ tenantId: z.string(), accountId: z.string() }),
        // At most 2 in flight for any one tenant …
        concurrency: { limit: 2, by: (input) => input.tenantId },
        // … and at most 5 starts per second for that tenant, burst of 5.
        throttle: {
          limit: 5,
          per: 1_000,
          burst: 5,
          by: (input) => input.tenantId,
        },
        run: async ({ tenantId }) => {
          // Decrement the CURRENT value, not the one read on entry: handlers
          // interleave, so `now - 1` would corrupt the count and misreport.
          const current = (active.get(tenantId) ?? 0) + 1;
          active.set(tenantId, current);
          peak.set(tenantId, Math.max(peak.get(tenantId) ?? 0, current));
          await new Promise((resolve) => setTimeout(resolve, 25));
          active.set(tenantId, (active.get(tenantId) ?? 1) - 1);
        },
      }),
    },
    driver,
    { worker: { concurrency: 16 } }
  );

  step("acme and globex each submit 6 account syncs, all at once …");
  const started = Date.now();
  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) =>
      jobs.syncAccount({ tenantId: "acme", accountId: `a${i}` })
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      jobs.syncAccount({ tenantId: "globex", accountId: `g${i}` })
    ),
  ]);
  await jobs.worker.onIdle();
  const elapsed = Date.now() - started;

  expect(peak.get("acme") <= 2, `acme never exceeded 2 in flight (peak ${peak.get("acme")})`);
  expect(peak.get("globex") <= 2, `globex never exceeded 2 in flight (peak ${peak.get("globex")})`);

  // The buckets are independent, so 12 jobs did not serialise behind one cap.
  expect(
    (peak.get("acme") ?? 0) + (peak.get("globex") ?? 0) > 2,
    "tenants ran in parallel with each other — the limits are per key, not global"
  );

  const stats = await jobs.queue.stats();
  expect(stats.succeeded === 12, "all 12 syncs completed");
  step(`finished in ${elapsed}ms`);

  await jobs.worker.close();
  await driver.close();
  summary(`Scenario 2 (${backend})`);
}

for (const backend of backends()) {
  await run(backend);
}
