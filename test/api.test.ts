import { randomUUID } from "node:crypto";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import { z } from "zod";
import {
  JobCancelledError,
  JobTimeoutError,
  JobValidationError,
  QueueClosedError,
  enqiu,
  job,
  type Enqiu,
  type EnqiuOptions,
  type JobContext,
  type JobDefinitions,
} from "../src/index.js";

const redisUrl = process.env.ENQIU_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

// BullMQ takes the URL as-is, so nothing here has to parse out host and port.
const connection: EnqiuOptions["connection"] = { url: redisUrl ?? "" };

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeout = 5_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeRedis("enqiu over BullMQ", () => {
  let prefix: string;
  let open: Array<Enqiu<JobDefinitions>>;

  const make = <Definitions extends JobDefinitions>(
    definitions: Definitions,
    options: Partial<Omit<EnqiuOptions, "connection">> = {}
  ) => {
    const instance = enqiu(definitions, {
      name: `t-${randomUUID()}`,
      connection,
      prefix,
      ...options,
    });
    open.push(instance as unknown as Enqiu<JobDefinitions>);
    return instance;
  };

  beforeEach(() => {
    prefix = `enqiu-test:${randomUUID()}`;
    open = [];
  });

  afterEach(async () => {
    await Promise.all(
      open.map((instance) =>
        instance.close({ drain: false }).catch(() => undefined)
      )
    );
  });

  describe("typing", () => {
    it("infers schema input, handler input, and output", async () => {
      const { jobs } = make({
        parse: job({
          input: z.object({ raw: z.string() }),
          run: async (input) => ({ length: input.raw.length }),
        }),
      });

      expectTypeOf(jobs.parse).parameter(0).toMatchTypeOf<{ raw: string }>();
      const handle = await jobs.parse({ raw: "hello" });
      await expect(handle.result).resolves.toEqual({ length: 5 });
      expectTypeOf(handle.result).resolves.toMatchTypeOf<{ length: number }>();
    });

    it("correlates the job name with its own input and output", async () => {
      const { jobs } = make({
        sendEmail: job({
          input: z.object({ to: z.string() }),
          run: async (input) => ({ delivered: true, to: input.to }),
        }),
        resizeImage: job({
          input: z.object({ key: z.string(), width: z.number() }),
          run: async (input) => ({ bytes: input.width * 10 }),
        }),
      });

      // BullMQ's own generics are per queue — Queue<DataType, ResultType,
      // NameType> — so with two job types on one queue the data type becomes a
      // union and this pairing compiles there. Here it must not.
      await expect(
        // @ts-expect-error resizeImage's payload does not belong to sendEmail
        jobs.sendEmail({ key: "photo.jpg", width: 800 })
      ).rejects.toBeInstanceOf(JobValidationError);

      const handle = await jobs.resizeImage({ key: "p.jpg", width: 4 });
      const result = await handle.result;
      // The result is this job's, not a union across the queue.
      expectTypeOf(result).toMatchTypeOf<{ bytes: number }>();
      expect(result.bytes).toBe(40);
    });

    it("supports a bare handler with no schema", async () => {
      const { jobs } = make({ double: async (value: number) => value * 2 });
      const handle = await jobs.double(21);
      await expect(handle.result).resolves.toBe(42);
    });

    it("passes a typed context to the handler", async () => {
      const seen: string[] = [];
      const { jobs } = make({
        work: job({
          input: z.object({ id: z.string() }),
          run: async (input, context: JobContext) => {
            seen.push(`${context.name}:${input.id}:${context.attempt}`);
            return input.id;
          },
        }),
      });
      await (await jobs.work({ id: "a" })).result;
      expect(seen).toEqual(["work:a:1"]);
    });

    it("reserves no job names at all", async () => {
      // The queue and worker controls sit beside your jobs rather than among
      // them, so none of their names is taken.
      const { jobs, queue } = make({
        queue: async (n: number) => n * 2,
        worker: async (n: number) => n + 1,
        bull: async (n: number) => n - 1,
        close: async (n: number) => -n,
      });
      await expect((await jobs.queue(21)).result).resolves.toBe(42);
      await expect((await jobs.worker(1)).result).resolves.toBe(2);
      await expect((await jobs.bull(1)).result).resolves.toBe(0);
      await expect((await jobs.close(5)).result).resolves.toBe(-5);
      await queue.onIdle();
      expect((await queue.stats()).succeeded).toBe(4);
    });
  });

  describe("validation", () => {
    it("rejects invalid input before anything is queued", async () => {
      const { jobs, queue } = make({
        positive: job({
          input: z.number().positive(),
          run: async (value) => value,
        }),
      });
      await expect(jobs.positive(-1)).rejects.toBeInstanceOf(
        JobValidationError
      );
      expect((await queue.stats()).total).toBe(0);
    });

    it("rejects input that cannot be serialised", async () => {
      const { jobs } = make({ work: async (value: unknown) => value });
      await expect(jobs.work({ fn: () => 1 })).rejects.toThrow(
        "function is unsupported"
      );
    });

    it("requires at least one job", () => {
      expect(() => enqiu({}, { connection })).toThrow(
        "At least one job definition is required"
      );
    });
  });

  describe("policies Enqiu enforces itself", () => {
    it("times out an attempt and aborts the handler's signal", async () => {
      let reason: unknown;
      const { jobs } = make({
        slow: job({
          input: z.object({}),
          timeout: 60,
          run: async (_input, context) => {
            context.signal.addEventListener("abort", () => {
              reason = context.signal.reason;
            });
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          },
        }),
      });
      const handle = await jobs.slow({});
      // The kind of failure is written down rather than spelled out in prose,
      // so it survives the trip through Redis as a class, not a string.
      await expect(handle.result).rejects.toBeInstanceOf(JobTimeoutError);
      await expect(handle.result).rejects.toThrow("timed out after 60ms");
      expect(reason).toBeInstanceOf(JobTimeoutError);
      expect((await handle.refresh()).error?.name).toBe("JobTimeoutError");
    });

    it("expires work that waited too long, without retrying it", async () => {
      let runs = 0;
      const { jobs, worker } = make(
        {
          stale: job({
            input: z.object({}),
            expiresIn: 40,
            retry: { attempts: 3 },
            run: async () => {
              runs += 1;
            },
          }),
        },
        { worker: { autoStart: false } }
      );
      const handle = await jobs.stale({});
      await new Promise((resolve) => setTimeout(resolve, 80));
      await worker.start();
      await expect(handle.result).rejects.toThrow("expired");
      expect(runs).toBe(0);
      expect((await handle.refresh()).error?.name).toBe("JobExpiredError");
    });
  });

  describe("policies BullMQ provides", () => {
    it("retries with backoff and reports one-based attempts", async () => {
      const attempts: number[] = [];
      const { jobs } = make({
        flaky: job({
          input: z.object({}),
          retry: { attempts: 3, backoff: 10 },
          run: async (_input, context) => {
            attempts.push(context.attempt);
            if (attempts.length < 3) throw new Error("try again");
            return "ok";
          },
        }),
      });
      await expect((await jobs.flaky({})).result).resolves.toBe("ok");
      expect(attempts).toEqual([1, 2, 3]);
    });

    it("falls back to the queue-wide retry default", async () => {
      const attempts: number[] = [];
      const { jobs } = make(
        {
          flaky: job({
            input: z.object({}),
            run: async (_input, context) => {
              attempts.push(context.attempt);
              if (attempts.length < 2) throw new Error("try again");
              return "ok";
            },
          }),
        },
        { retry: { attempts: 2, backoff: 5 } }
      );
      await expect((await jobs.flaky({})).result).resolves.toBe("ok");
      expect(attempts).toEqual([1, 2]);
    });

    it("fails terminally once attempts are exhausted", async () => {
      const { jobs } = make({
        doomed: job({
          input: z.object({}),
          retry: { attempts: 2, backoff: 5 },
          run: async () => {
            throw new Error("always fails");
          },
        }),
      });
      const handle = await jobs.doomed({});
      await expect(handle.result).rejects.toThrow("always fails");
      expect((await handle.refresh()).status).toBe("failed");
    });

    it("reuses a job for a repeated idempotency key", async () => {
      const { jobs } = make({ work: async (n: number) => n }, { worker: false });
      const first = await jobs.work(1, { idempotencyKey: "once" });
      const second = await jobs.work(2, { idempotencyKey: "once" });
      expect(second.id).toBe(first.id);
      expect(second.deduplicated).toBe(true);
      expect(first.deduplicated).toBe(false);
    });

    it("submits in bulk and honours explicit ids", async () => {
      const { jobs } = make({ work: async (n: number) => n }, { worker: false });
      const handles = await jobs.work.bulk([1, 2, 3], { ids: ["a", "b", "c"] });
      expect(handles.map((h) => h.id)).toEqual(["a", "b", "c"]);
      await expect(jobs.work.bulk([1], { ids: ["x", "y"] })).rejects.toThrow(
        "bulk ids must match"
      );
    });

    it("delays a job and reports it as scheduled", async () => {
      const { jobs } = make({ work: async (n: number) => n }, { worker: false });
      const handle = await jobs.work(1, { delay: 30_000 });
      expect((await handle.refresh()).status).toBe("scheduled");
    });
  });

  describe("queue and worker control", () => {
    it("reports stats whose parts sum to the total", async () => {
      const { jobs, queue } = make({ work: async (n: number) => n });
      await jobs.work.bulk([1, 2, 3]);
      await queue.onIdle();
      const stats = await queue.stats();
      expect(
        stats.queued +
          stats.scheduled +
          stats.running +
          stats.succeeded +
          stats.failed
      ).toBe(stats.total);
      expect(stats.succeeded).toBe(3);
    });

    it("lists jobs and reads one back by id", async () => {
      const { jobs, queue } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      const handle = await jobs.work(7);
      const page = await queue.list({ status: "queued", limit: 10 });
      expect(page.jobs.map((j) => j.id)).toContain(handle.id);
      expect((await queue.get(handle.id))?.input).toBe(7);
      expect(await queue.get("missing")).toBeUndefined();
      await expect(
        queue.list({ status: "queued", limit: 0 })
      ).rejects.toThrow("list.limit");
      await expect(
        queue.list({ status: "queued", cursor: "nope" })
      ).rejects.toThrow("Invalid list cursor");
    });

    it("pages through a status without skipping or repeating a job", async () => {
      const { jobs, queue } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      await jobs.work.bulk([1, 2, 3, 4, 5]);
      // A prioritized job is queued too, and lives in a different Redis
      // structure — which is exactly what a single-number cursor got wrong.
      await jobs.work(6, { priority: "high" });

      const seen: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await queue.list({
          status: "queued",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.jobs.every((j) => j.status === "queued")).toBe(true);
        seen.push(...page.jobs.map((j) => j.id));
        if (page.cursor === undefined) break;
        cursor = page.cursor;
      }
      expect(seen).toHaveLength(6);
      expect(new Set(seen).size).toBe(6);
    });

    it("cancels a job that has not started", async () => {
      const { jobs } = make({ work: async (n: number) => n }, { worker: false });
      const handle = await jobs.work(1);
      await expect(handle.cancel()).resolves.toBe(true);
      expect((await handle.refresh()).status).toBe("cancelled");
      await expect(handle.result).rejects.toBeInstanceOf(JobCancelledError);
    });

    it("redrives a failed job and cleans up finished work", async () => {
      let succeed = false;
      const { jobs, queue } = make({
        work: job({
          input: z.object({}),
          run: async () => {
            if (!succeed) throw new Error("first run fails");
            return "recovered";
          },
        }),
      });
      const handle = await jobs.work({});
      await expect(handle.result).rejects.toThrow("first run fails");

      succeed = true;
      const again = await queue.redrive(handle.id);
      await queue.onIdle();
      expect((await again.refresh()).status).toBe("succeeded");

      await expect(queue.redrive("missing")).rejects.toThrow(
        "cannot be redriven"
      );
      const removed = await queue.cleanup({ status: "succeeded" });
      expect(removed.length).toBeGreaterThan(0);
    });

    it("pauses and resumes the worker", async () => {
      const { jobs, worker } = make({ work: async (n: number) => n });
      expect(worker.running).toBe(true);
      await worker.pause();
      expect(worker.running).toBe(false);
      await worker.start({ concurrency: 2 });
      expect(worker.running).toBe(true);
      await expect((await jobs.work(3)).result).resolves.toBe(3);
    });

    it("refuses to start a worker on a producer-only queue", async () => {
      const { worker } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      await expect(worker.start()).rejects.toThrow("worker: false");
      expect(worker.running).toBe(false);
    });

    it("closes the whole instance, worker or not", async () => {
      const producer = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      await producer.close();
      await expect(producer.jobs.work(1)).rejects.toBeInstanceOf(
        QueueClosedError
      );
    });
  });

  describe("observability", () => {
    it("records progress and logs on the job", async () => {
      const { jobs } = make({
        work: job({
          input: z.object({}),
          run: async (_input, context) => {
            context.log.info("halfway", { pct: 50 });
            await context.reportProgress({ completed: 1, total: 2 });
            return "done";
          },
        }),
      });
      const handle = await jobs.work({});
      await handle.result;
      const snapshot = await handle.refresh();
      expect(snapshot.progress).toMatchObject({ completed: 1, total: 2 });
    });

    it("rejects malformed progress and empty log messages", async () => {
      const { jobs } = make({
        bad: job({
          input: z.object({}),
          run: async (_input, context) => {
            await context.reportProgress({ completed: 3, total: 2 });
          },
        }),
        empty: job({
          input: z.object({}),
          run: async (_input, context) => {
            context.log.info("");
          },
        }),
      });
      await expect((await jobs.bad({})).result).rejects.toThrow(
        "Progress requires"
      );
      await expect((await jobs.empty({})).result).rejects.toThrow(
        "must not be empty"
      );
    });

    it("forwards the worker's own lifecycle to telemetry, not just Enqiu's", async () => {
      const events: string[] = [];
      const { jobs } = make(
        {
          work: job({
            input: z.object({}),
            run: async (_input, context) => {
              context.log.info("note");
              return 1;
            },
          }),
          doomed: job({
            input: z.object({}),
            run: async () => {
              throw new Error("nope");
            },
          }),
        },
        { telemetry: { emit: (event) => events.push(event.type) } }
      );
      await (await jobs.work({})).result;
      await (await jobs.doomed({})).result.catch(() => undefined);
      await waitFor(() => events.includes("job.failed"));

      expect(events).toContain("job.log.info");
      // A completion and a failure are what anyone wiring telemetry came for.
      expect(events).toContain("job.succeeded");
      expect(events).toContain("job.failed");
    });

    it("logs at every level", async () => {
      const { jobs } = make({
        noisy: job({
          input: z.object({}),
          run: async (_i, context) => {
            context.log.debug("d");
            context.log.info("i");
            context.log.warn("w");
            context.log.error("e");
            return 1;
          },
        }),
      });
      await expect((await jobs.noisy({})).result).resolves.toBe(1);
    });
  });

  describe("schedules", () => {
    it("registers, inspects and removes a cron schedule", async () => {
      const { jobs } = make(
        { digest: job({ input: z.object({}), run: async () => 1 }) },
        { worker: false }
      );
      const schedule = await jobs.digest.schedule({
        id: "weekly",
        cron: "0 9 * * 1",
        timezone: "Europe/Nicosia",
        input: {},
      });
      const snapshot = await schedule.refresh();
      expect(snapshot.cron).toBe("0 9 * * 1");
      expect(snapshot.timezone).toBe("Europe/Nicosia");
      expect(snapshot.nextRunAt).toBeGreaterThan(Date.now());
      await schedule.remove();
      await expect(schedule.refresh()).rejects.toThrow("does not exist");
    });
  });

  describe("event subscription", () => {
    it("delivers lifecycle events to subscribers", async () => {
      const { jobs, queue } = make({ work: async (n: number) => n });
      const seen: string[] = [];
      const off = queue.on("succeeded", (s) => seen.push(`succeeded:${s.id}`));
      queue.on("added", (s) => seen.push(`added:${s.id}`));
      queue.on("started", (s) => seen.push(`started:${s.id}`));

      // No warm-up: the stream opens from a captured tail, so even the very
      // first job submitted after subscribing must be seen.
      const handle = await jobs.work(2);
      await handle.result;
      await waitFor(() => seen.includes(`succeeded:${handle.id}`));

      expect(seen).toContain(`added:${handle.id}`);
      expect(seen).toContain(`started:${handle.id}`);

      off();
      const afterUnsubscribe = seen.filter((e) =>
        e.startsWith("succeeded:")
      ).length;
      const last = await jobs.work(3);
      await last.result;
      await new Promise((r) => setTimeout(r, 200));
      expect(seen.filter((e) => e.startsWith("succeeded:")).length).toBe(
        afterUnsubscribe
      );
    });

    it("reports a failure to subscribers", async () => {
      const { jobs, queue } = make({
        doomed: job({
          input: z.object({}),
          run: async () => {
            throw new Error("nope");
          },
        }),
      });
      const failures: string[] = [];
      queue.on("failed", (snapshot) => failures.push(snapshot.id));
      const handle = await jobs.doomed({});
      await handle.result.catch(() => undefined);
      await waitFor(() => failures.length === 1);
      expect(failures[0]).toBe(handle.id);
    });
  });

  describe("cancellation", () => {
    it("aborts a job that is already running", async () => {
      let aborted = false;
      const { jobs } = make({
        slow: job({
          input: z.object({}),
          run: async (_input, context) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 5_000);
              context.signal.addEventListener("abort", () => {
                aborted = true;
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            }),
        }),
      });

      const handle = await jobs.slow({});
      await waitFor(async () => (await handle.refresh()).status === "running");
      expect(await handle.cancel("operator stopped it")).toBe(true);
      await waitFor(() => aborted);
      expect(aborted).toBe(true);
    });

    it("keeps the cancelled job's own name and input, not a stub", async () => {
      const { jobs, queue } = make(
        { sendEmail: async (input: { to: string }) => input },
        { worker: false }
      );
      const handle = await jobs.sendEmail({ to: "a@b.c" });
      expect(await handle.cancel("changed my mind")).toBe(true);

      // The job is gone from BullMQ, so the marker is the only record — and it
      // kept what the job actually was.
      const snapshot = await queue.get(handle.id);
      expect(snapshot?.status).toBe("cancelled");
      expect(snapshot?.name).toBe("sendEmail");
      expect(snapshot?.input).toEqual({ to: "a@b.c" });
      expect(snapshot?.error?.message).toBe("changed my mind");
    });

    it("records a cancellation durably, so another process sees it", async () => {
      const name = `shared-${randomUUID()}`;
      const producer = make({ work: async (n: number) => n }, {
        name,
        worker: false,
      });
      const observer = make({ work: async (n: number) => n }, {
        name,
        worker: false,
      });

      const handle = await producer.jobs.work(1);
      expect(await handle.cancel("not needed")).toBe(true);

      // A different instance, with no in-process memory of the cancellation.
      const seen = await observer.queue.get(handle.id);
      expect(seen?.status).toBe("cancelled");
      expect(seen?.error?.message).toBe("not needed");
    });

    it("prunes markers once their jobs are old enough to clean", async () => {
      const { jobs, queue } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      const handle = await jobs.work(1);
      await handle.cancel();
      expect((await queue.get(handle.id))?.status).toBe("cancelled");

      // olderThan 0 makes every marker stale, so the hash is emptied.
      await queue.cleanup({ olderThan: 0 });
      expect(await queue.get(handle.id)).toBeUndefined();
    });

    it("has nothing to list or clean for a status BullMQ does not have", async () => {
      const { jobs, queue } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      await jobs.work(1);
      expect((await queue.list({ status: "cancelled" })).jobs).toEqual([]);
      expect(await queue.cleanup({ status: "cancelled" })).toEqual([]);
    });
  });

  describe("multiple workers", () => {
    it("shares one queue without running a job twice", async () => {
      const name = `pool-${randomUUID()}`;
      const byWorker = new Map<string, number>();
      const processed: number[] = [];

      const spawn = (label: string) =>
        make(
          {
            work: job({
              input: z.object({ n: z.number() }),
              run: async ({ n }) => {
                byWorker.set(label, (byWorker.get(label) ?? 0) + 1);
                processed.push(n);
                await new Promise((r) => setTimeout(r, 5));
                return n;
              },
            }),
          },
          { name, worker: { concurrency: 2 } }
        );

      const a = spawn("a");
      const b = spawn("b");

      await a.jobs.work.bulk(Array.from({ length: 20 }, (_, i) => ({ n: i })));
      await a.queue.onIdle();
      await b.queue.onIdle();

      expect(processed).toHaveLength(20);
      expect(new Set(processed).size).toBe(20);
      expect(byWorker.size).toBe(2);
      expect((await a.queue.stats()).succeeded).toBe(20);
    });
  });

  describe("the BullMQ objects underneath", () => {
    it("exposes them", async () => {
      const producer = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      expect(producer.bull.queue.name).toBeTypeOf("string");
      expect(typeof producer.bull.queue.getJobCounts).toBe("function");
      expect(producer.bull.worker).toBeUndefined();

      const withWorker = make({ work: async (n: number) => n });
      expect(typeof withWorker.bull.worker?.run).toBe("function");
    });

    it("reports itself closed when the BullMQ queue is closed underneath", async () => {
      const { jobs, bull } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      await bull.queue.close();
      // Read from BullMQ rather than a flag maintained alongside, so the two
      // cannot drift apart.
      await expect(jobs.work(1)).rejects.toBeInstanceOf(QueueClosedError);
    });

    it("stops reporting a worker as running once BullMQ pauses it", async () => {
      const { worker, bull } = make({ work: async (n: number) => n });
      expect(worker.running).toBe(true);
      await bull.worker?.pause();
      expect(worker.running).toBe(false);
    });
  });

  describe("argument validation", () => {
    it("rejects a malformed job definition", () => {
      expect(() => job(undefined as never)).toThrow("requires a definition");
      expect(() => job({ input: {} as never, run: async () => 1 })).toThrow(
        "must implement Standard Schema"
      );
      expect(() => job({ input: z.object({}), run: "nope" as never })).toThrow(
        "job.run must be a function"
      );
      expect(() =>
        enqiu({ work: { bad: true } as never }, { connection })
      ).toThrow("handler or a definition created with job()");
    });

    it("requires a connection", () => {
      expect(() => enqiu({ work: async () => 1 }, {} as never)).toThrow(
        "requires a BullMQ connection"
      );
    });

    it("rejects out-of-range queue arguments", async () => {
      const { jobs, queue } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      await expect(queue.setConcurrency(0)).rejects.toThrow(
        "concurrency must be a positive integer"
      );
      await expect(queue.cleanup({ olderThan: -1 })).rejects.toThrow(
        "non-negative finite"
      );
      await expect(jobs.work(1, { retry: { attempts: 0 } })).rejects.toThrow(
        "retry.attempts must be a positive integer"
      );
    });

    it("accepts every documented submit option shape", async () => {
      const { jobs } = make({ work: async (n: number) => n }, { worker: false });
      const byDate = await jobs.work(1, {
        delay: new Date(Date.now() + 60_000),
      });
      expect((await byDate.refresh()).status).toBe("scheduled");

      expect((await jobs.work(2, { priority: 5 })).id).toBeTypeOf("string");
      expect((await jobs.work(3, { priority: "low" })).id).toBeTypeOf("string");
      expect(
        (
          await jobs.work(4, {
            retry: { attempts: 2, backoff: { type: "exponential", delay: 10 } },
          })
        ).id
      ).toBeTypeOf("string");
      expect(
        (await jobs.work(5, { idempotencyKey: "k", idempotencyTtl: 1_000 })).id
      ).toBeTypeOf("string");
    });

    it("lists every status without complaint", async () => {
      const { queue } = make(
        { work: async (n: number) => n },
        { worker: false }
      );
      for (const status of [
        "queued",
        "scheduled",
        "running",
        "succeeded",
        "failed",
      ] as const) {
        expect(Array.isArray((await queue.list({ status })).jobs)).toBe(true);
      }
    });

    it("exposes name and input on the handle, and resumes a paused worker", async () => {
      const { jobs, worker } = make({ work: async (n: number) => n });
      const handle = await jobs.work(9);
      expect(handle.name).toBe("work");
      expect(handle.input).toBe(9);

      await worker.pause();
      await worker.resume();
      expect(worker.running).toBe(true);
      await expect(handle.result).resolves.toBe(9);
    });
  });
});
