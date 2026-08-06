/**
 * Scenario 3 — Notification campaign
 *
 * Campaigns are bulk submissions where some messages outrank others, some are
 * scheduled for later, and a recurring digest runs on cron.
 *
 * Exercises: bulk(), priority tiers, delayed delivery, and cron schedules
 * (registered, inspected, paused and removed without waiting for a tick).
 */

import { z } from "zod";
import { enqiu, job } from "../../dist/index.js";
import { expect, heading, note, step, summary } from "./_harness.mjs";

heading(
  "3. Notification campaign",
  "bulk submission, priority tiers, delayed sends, and a cron digest"
);

const sent = [];

const jobs = enqiu(
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
  // One at a time so the priority ordering is observable rather than racy.
  { worker: { concurrency: 1, autoStart: false } }
);

step("queueing 5 marketing emails in bulk …");
const bulk = await jobs.sendEmail.bulk(
  Array.from({ length: 5 }, (_, i) => ({ to: `user${i}@example.com`, tier: "bulk" })),
  { priority: "low" }
);
expect(bulk.length === 5, "bulk() returned a handle per recipient");

step("a password reset jumps the queue …");
await jobs.sendEmail({ to: "urgent@example.com", tier: "reset" }, { priority: "high" });

step("starting the worker …");
await jobs.worker.start();
await jobs.worker.onIdle();

expect(sent[0] === "reset:urgent@example.com", "the high-priority reset was sent first");
expect(sent.length === 6, "every queued message was sent");

step("scheduling a reminder for 20s from now …");
const later = await jobs.sendEmail(
  { to: "later@example.com", tier: "reminder" },
  { delay: 20_000, priority: "normal" }
);
const pending = await later.refresh();
expect(pending.status === "scheduled", "a delayed job waits in `scheduled`");
expect(pending.runAt > Date.now(), "its runAt is in the future");
await later.cancel("scenario finished");
expect((await later.refresh()).status === "cancelled", "and it can be cancelled before firing");

step("registering a Monday 09:00 digest …");
const digest = await jobs.weeklyDigest.schedule({
  id: "weekly-digest",
  cron: "0 9 * * 1",
  timezone: "Europe/Nicosia",
  input: { segment: "active" },
});
const snapshot = await digest.refresh();
expect(snapshot.status === "active", "the schedule is active");
expect(snapshot.nextRunAt > Date.now(), "and it knows its next occurrence");
note(`next run: ${new Date(snapshot.nextRunAt).toISOString()}`);

await digest.pause();
expect((await digest.refresh()).status === "paused", "a schedule can be paused");
await digest.resume();
expect((await digest.refresh()).status === "active", "and resumed");
await digest.remove();

await jobs.worker.close();
summary("Scenario 3");
