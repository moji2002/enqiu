/**
 * Scenario 3 — Notification campaign
 *
 * Bulk submission where some messages outrank others, some are scheduled for
 * later, and a recurring digest runs on cron.
 *
 * Exercises: bulk(), priority tiers, delayed delivery, cron schedules.
 */

import { z } from "zod";
import { job } from "../../src/index.js";
import { expect, finish, heading, makeJobs, note, step } from "./_harness.js";

heading(
  "3. Notification campaign",
  "bulk submission, priority tiers, delayed sends, and a cron digest"
);

const sent: string[] = [];

const { jobs, queue, worker, close } = makeJobs(
  {
    sendEmail: job({
      input: z.object({ to: z.string(), tier: z.string() }),
      run: async ({ to, tier }) => {
        sent.push(`${tier}:${to}`);
        return { to };
      },
    }),
    weeklyDigest: job({
      input: z.object({ segment: z.string() }),
      run: async ({ segment }) => ({ segment }),
    }),
  },
  // One at a time so priority ordering is observable rather than racy.
  { worker: { concurrency: 1, autoStart: false } }
);

step("queueing 5 marketing emails in bulk …");
const bulk = await jobs.sendEmail.bulk(
  Array.from({ length: 5 }, (_, i) => ({
    to: `user${i}@example.com`,
    tier: "bulk",
  })),
  { priority: "low" }
);
expect(bulk.length === 5, "bulk() returned a handle per recipient");

step("a password reset jumps the queue …");
await jobs.sendEmail({ to: "urgent@example.com", tier: "reset" }, { priority: "high" });

step("starting the worker …");
await worker.start();
await queue.onIdle();

expect(sent[0] === "reset:urgent@example.com", "the high-priority reset went first");
expect(sent.length === 6, "every queued message was sent");

step("scheduling a reminder for later …");
const later = await jobs.sendEmail(
  { to: "later@example.com", tier: "reminder" },
  { delay: 30_000 }
);
expect((await later.refresh()).status === "scheduled", "a delayed job waits in `scheduled`");
expect(await later.cancel(), "and it can be cancelled before firing");

step("registering a Monday 09:00 digest …");
const digest = await jobs.weeklyDigest.schedule({
  id: "weekly-digest",
  cron: "0 9 * * 1",
  timezone: "Europe/Nicosia",
  input: { segment: "active" },
});
const snapshot = await digest.refresh();
expect(snapshot.cron === "0 9 * * 1", "the schedule kept its cron expression");
expect(snapshot.nextRunAt > Date.now(), "and knows its next occurrence");
note(`next run: ${new Date(snapshot.nextRunAt).toISOString()}`);
await digest.remove();

await finish("Scenario 3", close, { drain: false });
