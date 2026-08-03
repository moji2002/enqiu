import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  JobValidationError,
  job,
  enqiu,
  type JobContext,
  type StandardSchemaV1,
} from "../src/index.js";

function schema<Input, Output = Input>(
  validate: (input: Input) => Output
): StandardSchemaV1<Input, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "enqiu-test",
      validate(value) {
        try {
          return { value: validate(value as Input) };
        } catch (error) {
          return {
            issues: [
              {
                message:
                  error instanceof Error ? error.message : "Invalid input",
              },
            ],
          };
        }
      },
      types: undefined,
    },
  };
}

describe("public API", () => {
  it("infers schema input, parsed handler input, and output", async () => {
    const emailSchema = schema(
      (input: { to: string; attempts?: string }) => ({
        to: input.to,
        attempts: Number(input.attempts ?? "1"),
      })
    );
    const jobs = enqiu({
      sendEmail: job({
        input: emailSchema,
        run: async (input) => ({
          delivered: input.attempts,
        }),
      }),
    });

    expectTypeOf(jobs.sendEmail).parameter(0).toEqualTypeOf<{
      to: string;
      attempts?: string;
    }>();
    const handle = await jobs.sendEmail({
      to: "hello@enqiu.dev",
      attempts: "2",
    });

    expect(handle).not.toHaveProperty("then");
    expectTypeOf(await handle.result).toEqualTypeOf<{ delivered: number }>();
    await expect(handle.result).resolves.toEqual({ delivered: 2 });
  });

  it("supports handler-first inference and direct calls", async () => {
    const jobs = enqiu({
      double: async (input: number) => input * 2,
    });

    const handle = await jobs.double(21);
    expectTypeOf(await handle.result).toEqualTypeOf<number>();
    await expect(handle.result).resolves.toBe(42);
  });

  it("accepts typed handlers that use the job context", async () => {
    const jobs = enqiu({
      sendEmail: async (
        input: { to: string },
        { reportProgress }: JobContext,
      ) => {
        await reportProgress({ completed: 1, total: 1 });
        return { delivered: true, to: input.to };
      },
    });

    const handle = await jobs.sendEmail({ to: "hello@enqiu.dev" });
    expectTypeOf(await handle.result).toEqualTypeOf<{
      delivered: boolean;
      to: string;
    }>();
    await expect(handle.result).resolves.toEqual({
      delivered: true,
      to: "hello@enqiu.dev",
    });
  });

  it("validates before accepting a schema-first job", async () => {
    const jobs = enqiu({
      positive: job({
        input: schema((value: number) => {
          if (value <= 0) throw new Error("Must be positive");
          return value;
        }),
        run: async (value) => value,
      }),
    });

    await expect(jobs.positive(-1)).rejects.toBeInstanceOf(JobValidationError);
    expect((await jobs.queue.stats()).total).toBe(0);
  });

  it("does not create an unhandled completion rejection when ignored", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const jobs = enqiu({
        fail: async () => {
          throw new Error("boom");
        },
      });

      await jobs.fail(undefined);
      await jobs.worker.onIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("exposes schemas for Hono-compatible validation", () => {
    const input = schema((value: { id: string }) => value);
    const jobs = enqiu({
      work: job({
        input,
        run: async (value) => value.id,
      }),
    });

    expect(jobs.work.input).toBe(input);
  });

  it("reports structured progress", async () => {
    const updates: unknown[] = [];
    const jobs = enqiu({
      importData: async (_: undefined, context) => {
        await context.reportProgress({ completed: 2, total: 4 });
      },
    });
    jobs.queue.on("progress", (snapshot) => updates.push(snapshot.progress));

    const handle = await jobs.importData(undefined);
    await handle.result;
    expect(updates).toEqual([{ completed: 2, total: 4 }]);
  });

  it("expires stale work before execution", async () => {
    vi.useFakeTimers();
    const jobs = enqiu(
      {
        work: job({
          input: schema((value: number) => value),
          expiresIn: 100,
          run: async (value) => value,
        }),
      },
      { worker: false }
    );

    const handle = await jobs.work(1);
    await vi.advanceTimersByTimeAsync(100);
    await jobs.worker.resume();

    await expect(handle.result).rejects.toMatchObject({
      name: "JobExpiredError",
    });
    expect((await handle.refresh()).status).toBe("expired");
  });

  it("limits concurrency independently for each policy key", async () => {
    const releases: Array<() => void> = [];
    const active = new Map<string, number>();
    const peaks = new Map<string, number>();
    const jobs = enqiu(
      {
        work: job({
          input: schema((value: { organizationId: string }) => value),
          concurrency: {
            limit: 1,
            by: (input) => input.organizationId,
          },
          run: async ({ organizationId }) => {
            const count = (active.get(organizationId) ?? 0) + 1;
            active.set(organizationId, count);
            peaks.set(
              organizationId,
              Math.max(peaks.get(organizationId) ?? 0, count)
            );
            await new Promise<void>((resolve) => releases.push(resolve));
            active.set(organizationId, count - 1);
          },
        }),
      },
      { worker: { concurrency: 4 } }
    );

    const handles = await Promise.all([
      jobs.work({ organizationId: "a" }),
      jobs.work({ organizationId: "a" }),
      jobs.work({ organizationId: "b" }),
      jobs.work({ organizationId: "b" }),
    ]);
    await Promise.resolve();
    expect(releases).toHaveLength(2);

    while (releases.length > 0 || (await jobs.queue.stats()).running > 0) {
      releases.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(handles.map((handle) => handle.result));
    expect(peaks).toEqual(
      new Map([
        ["a", 1],
        ["b", 1],
      ])
    );
  });

  it("uses token-bucket throttling with burst capacity", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const jobs = enqiu({
      request: job({
        input: schema((value: number) => value),
        throttle: { limit: 2, per: 100, burst: 2 },
        run: async (value) => {
          starts.push(Date.now());
          return value;
        },
      }),
    });

    const handles = await jobs.request.bulk([1, 2, 3]);
    await Promise.resolve();
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(49);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(3);
    await Promise.all(handles.map((handle) => handle.result));
  });

  it("debounces trailing work using the latest input and one handle", async () => {
    vi.useFakeTimers();
    const values: number[] = [];
    const jobs = enqiu({
      rebuild: job({
        input: schema((value: { key: string; version: number }) => value),
        debounce: {
          wait: 100,
          mode: "trailing",
          by: (input) => input.key,
        },
        run: async (input) => {
          values.push(input.version);
          return input.version;
        },
      }),
    });

    const first = await jobs.rebuild({ key: "docs", version: 1 });
    await vi.advanceTimersByTimeAsync(50);
    const second = await jobs.rebuild({ key: "docs", version: 2 });
    expect(second.id).toBe(first.id);
    await vi.advanceTimersByTimeAsync(99);
    expect(values).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first.result).resolves.toBe(2);
    expect(values).toEqual([2]);
  });

  it("keeps completed idempotent results for the requested window", async () => {
    let calls = 0;
    const jobs = enqiu({
      charge: async (amount: number) => {
        calls += 1;
        return amount;
      },
    });

    const first = await jobs.charge(10, {
      idempotencyKey: "payment-1",
      idempotencyTtl: 1_000,
    });
    await first.result;
    const duplicate = await jobs.charge(999, {
      idempotencyKey: "payment-1",
      idempotencyTtl: 1_000,
    });

    expect(duplicate.id).toBe(first.id);
    await expect(duplicate.result).resolves.toBe(10);
    expect(calls).toBe(1);
  });

  it("runs, pauses, resumes, and removes memory cron schedules", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 30));
    const values: string[] = [];
    const jobs = enqiu({
      digest: async (audience: string) => {
        values.push(audience);
      },
    });

    const schedule = await jobs.digest.schedule({
      cron: "1 * * * *",
      timezone: "UTC",
      input: "active-users",
    });
    expect(schedule.id).toBe("digest");
    expect(schedule.nextRunAt).toBe(Date.UTC(2026, 0, 1, 0, 1));

    await vi.advanceTimersByTimeAsync(30_000);
    await jobs.worker.onIdle();
    expect(values).toEqual(["active-users"]);

    await schedule.pause();
    expect((await schedule.refresh()).status).toBe("paused");
    await schedule.resume();
    expect((await schedule.refresh()).status).toBe("active");
    await schedule.remove();
    await expect(schedule.refresh()).rejects.toThrow("does not exist");
    await jobs.worker.close();
  });
});
