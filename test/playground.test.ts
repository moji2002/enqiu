import { describe, expect, it } from "vitest";
import {
  createPlaygroundQueue,
  defaultDraft,
  submitDraft,
} from "../site/playground/queue.js";

describe("browser playground queue model", () => {
  it("runs every recipe through the real Enqiu queue", async () => {
    const queue = createPlaygroundQueue();
    try {
      const submissions = await Promise.all([
        submitDraft(queue, defaultDraft("sendEmail")),
        submitDraft(queue, defaultDraft("resizeImage")),
        submitDraft(queue, defaultDraft("syncAccount")),
      ]);

      await expect(
        Promise.all(submissions.map(({ handle }) => handle.result)),
      ).resolves.toHaveLength(3);
      await expect(queue.queue.stats()).resolves.toMatchObject({
        succeeded: 3,
        total: 3,
      });
    } finally {
      await queue.worker.close({ drain: false });
    }
  });

  it("rejects invalid JSON before creating a queue job", async () => {
    const queue = createPlaygroundQueue();
    try {
      await expect(
        submitDraft(queue, {
          ...defaultDraft(),
          payload: '{ "to": "hello@example.com",',
        }),
      ).rejects.toThrow(/valid JSON.*line 1/i);
      await expect(queue.queue.stats()).resolves.toMatchObject({ total: 0 });
    } finally {
      await queue.worker.close({ drain: false });
    }
  });

  it("keeps delayed work scheduled while the worker is available", async () => {
    const queue = createPlaygroundQueue();
    try {
      const { handle } = await submitDraft(queue, {
        ...defaultDraft(),
        delayMs: 2_000,
      });
      await expect(queue.queue.get(handle.id)).resolves.toMatchObject({
        status: "scheduled",
      });
    } finally {
      await queue.worker.close({ drain: false });
    }
  });

  it("retries a deterministic first failure and retains real evidence", async () => {
    const queue = createPlaygroundQueue();
    try {
      const { handle } = await submitDraft(queue, {
        ...defaultDraft("syncAccount"),
        failOnce: true,
        retryAttempts: 2,
      });
      await expect(handle.result).resolves.toMatchObject({ records: 24 });
      await expect(queue.queue.get(handle.id)).resolves.toMatchObject({
        status: "succeeded",
        attempt: 2,
      });
      expect((await queue.queue.get(handle.id))?.logs?.length).toBeGreaterThan(0);
    } finally {
      await queue.worker.close({ drain: false });
    }
  });

  it("cancels queued work through the public handle", async () => {
    const queue = createPlaygroundQueue();
    try {
      await queue.worker.pause();
      const { handle } = await submitDraft(queue, defaultDraft("resizeImage"));
      await expect(handle.cancel("Playground test")).resolves.toBe(true);
      await expect(queue.queue.get(handle.id)).resolves.toMatchObject({
        status: "cancelled",
      });
    } finally {
      await queue.worker.close({ drain: false });
    }
  });

  it("redrives a failed job through the public queue API", async () => {
    const queue = createPlaygroundQueue();
    try {
      const { handle } = await submitDraft(queue, {
        ...defaultDraft("syncAccount"),
        failOnce: true,
        retryAttempts: 1,
      });
      await expect(handle.result).rejects.toThrow("temporarily unavailable");
      await expect(queue.queue.get(handle.id)).resolves.toMatchObject({
        status: "failed",
      });

      const redriven = await queue.queue.redrive(handle.id);
      await expect(redriven.result).resolves.toMatchObject({ records: 24 });
      await expect(queue.queue.get(handle.id)).resolves.toMatchObject({
        status: "succeeded",
      });
    } finally {
      await queue.worker.close({ drain: false });
    }
  });

  it("preserves custom ID and priority in the queue snapshot", async () => {
    const queue = createPlaygroundQueue();
    try {
      await queue.worker.pause();
      const { handle } = await submitDraft(queue, {
        ...defaultDraft(),
        customId: "playground:custom-job",
        priority: "high",
      });
      expect(handle.id).toBe("playground:custom-job");
      await expect(queue.queue.get(handle.id)).resolves.toMatchObject({
        id: "playground:custom-job",
        priority: 10,
        status: "queued",
      });
    } finally {
      await queue.worker.close({ drain: false });
    }
  });
});
