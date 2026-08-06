/**
 * Scenario 5 — Local-first autosave, in the browser tab
 *
 * This is where Enqiu differs from a server-only queue: the memory driver runs
 * in the tab. It is NOT a Background Sync substitute — it dies with the tab —
 * so it fits the "foreground queue" role: sequencing and debouncing work while
 * the user is present.
 *
 * Exercises: trailing debounce keyed per document, and expiresIn for work that
 * is pointless if it did not start promptly.
 */

import { z } from "zod";
import { enqiu, job } from "../../dist/index.js";
import { expect, heading, note, sleep, step, summary } from "./_harness.mjs";

heading(
  "5. Local-first autosave",
  "an in-tab queue: debounce keystrokes, drop work that went stale"
);

const saves = [];

const jobs = enqiu({
  saveDocument: job({
    input: z.object({ docId: z.string(), body: z.string() }),
    // Trailing: wait for the typing to stop, then save once with the latest.
    // 150ms is arbitrary — no source offers a measured value for this.
    debounce: { wait: 150, mode: "trailing", by: (input) => input.docId },
    run: async ({ docId, body }) => {
      saves.push({ docId, body });
      return { docId, length: body.length };
    },
  }),
  refreshSearchIndex: job({
    input: z.object({ docId: z.string() }),
    // If this did not start within 100ms it is already superseded.
    expiresIn: 100,
    run: async ({ docId }) => ({ docId }),
  }),
});

step("user types 'H','He','Hel','Hell','Hello' into doc-1 …");
for (const body of ["H", "He", "Hel", "Hell", "Hello"]) {
  await jobs.saveDocument({ docId: "doc-1", body });
  await sleep(20);
}

step("and edits doc-2 once, concurrently …");
await jobs.saveDocument({ docId: "doc-2", body: "notes" });

await sleep(400);
await jobs.worker.onIdle();

expect(saves.length === 2, `5 keystrokes + 1 edit collapsed into ${saves.length} saves`);
const doc1 = saves.find((s) => s.docId === "doc-1");
expect(doc1.body === "Hello", "doc-1 saved the LATEST body, not the first");
expect(saves.some((s) => s.docId === "doc-2"), "doc-2 debounced independently — the key isolates documents");

step("queueing an index refresh, then stalling the worker past its deadline …");
await jobs.worker.pause();
const stale = await jobs.refreshSearchIndex({ docId: "doc-1" });
await sleep(150);
await jobs.worker.start();
await jobs.worker.onIdle();

expect((await stale.refresh()).status === "expired",
  "work that missed its window expired instead of running late");
note("an in-tab queue is non-durable by design: closing the tab drops the queue.");

await jobs.worker.close();
summary("Scenario 5");
