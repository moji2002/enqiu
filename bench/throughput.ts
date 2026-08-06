/**
 * Enqiu vs BullMQ, same Redis, same workload.
 *
 * Fairness rules this follows, because a benchmark that flatters its author is
 * worth nothing:
 *   - identical Redis instance, identical trivial handler, identical job count
 *   - each library gets its own key namespace, flushed between runs
 *   - one warmup run is discarded, then N measured runs; the median is reported
 *   - both submit in bulk where the API offers it
 *   - Enqiu is measured at its DEFAULT poll interval as well as a tuned one,
 *     because tuning only one contestant is how benchmarks lie
 *
 * The architectural asymmetry is stated rather than hidden: BullMQ blocks on
 * Redis for the next job, Enqiu polls. Polling trades latency for simplicity,
 * and that shows up most in the single-job latency test.
 */

import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { enqiu, redis } from "../src/index.js";
import type { RedisCommandClient } from "../src/index.js";

const URL = process.env.ENQIU_TEST_REDIS_URL;
if (!URL) {
  console.error("Set ENQIU_TEST_REDIS_URL to run the benchmark.");
  process.exit(1);
}

const JOBS = Number(process.env.BENCH_JOBS ?? 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 16);
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
/**
 * Simulated work per job. At 0 the benchmark measures pure queue overhead,
 * which is the harshest possible framing; real jobs do I/O, and that is what
 * decides whether the overhead is even visible.
 */
const WORK_MS = Number(process.env.BENCH_WORK_MS ?? 0);
const work = async () => {
  if (WORK_MS > 0) await new Promise((r) => setTimeout(r, WORK_MS));
};

const median = (values: number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

const rate = (ms: number): string =>
  `${Math.round(JOBS / (ms / 1000)).toLocaleString()} jobs/sec`;

async function flush(prefix: string): Promise<void> {
  const client = new IORedis(URL as string, { maxRetriesPerRequest: null });
  const keys = await client.keys(`${prefix}*`);
  if (keys.length > 0) await client.del(...keys);
  await client.quit();
}

/** Drains JOBS trivial jobs through BullMQ and returns wall-clock ms. */
async function bullmq(): Promise<number> {
  const prefix = "bench-bullmq";
  await flush(`${prefix}:`);
  const connection = new IORedis(URL as string, { maxRetriesPerRequest: null });
  const queue = new Queue("bench", { connection, prefix });

  let done = 0;
  let finished: () => void;
  const allDone = new Promise<void>((resolve) => {
    finished = resolve;
  });

  const worker = new Worker(
    "bench",
    async (job) => {
      await work();
      done += 1;
      if (done === JOBS) finished();
      return job.data;
    },
    { connection, prefix, concurrency: CONCURRENCY, autorun: false }
  );
  await worker.waitUntilReady();

  const started = process.hrtime.bigint();
  await queue.addBulk(
    Array.from({ length: JOBS }, (_, i) => ({
      name: "work",
      data: { i },
      opts: { removeOnComplete: true, removeOnFail: true },
    }))
  );
  void worker.run();
  await allDone;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  await worker.close();
  await queue.close();
  await connection.quit();
  return ms;
}

/** Drains JOBS trivial jobs through Enqiu's Redis driver. */
async function enqiuRedis(pollInterval: number): Promise<number> {
  const prefix = `bench-enqiu-${pollInterval}`;
  await flush(`${prefix}:`);
  const client = new IORedis(URL as string, { maxRetriesPerRequest: null });
  const command: RedisCommandClient = {
    sendCommand: (args) =>
      // ioredis exposes a generic command call; BullMQ uses the same client.
      (client as unknown as {
        call(...a: string[]): Promise<unknown>;
      }).call(...args),
  };

  const jobs = enqiu(
    {
      work: async (value: { i: number }) => {
        await work();
        return value;
      },
    },
    {
      name: "bench",
      driver: redis(command, { prefix, pollInterval }),
      worker: { concurrency: CONCURRENCY },
    }
  );

  const started = process.hrtime.bigint();
  await jobs.work.bulk(Array.from({ length: JOBS }, (_, i) => ({ i })));
  await jobs.worker.onIdle();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  await jobs.worker.close({ drain: false });
  await client.quit();
  return ms;
}

/** Enqiu's in-process driver: no I/O at all. A different category, not a rival. */
async function enqiuMemory(): Promise<number> {
  const jobs = enqiu(
    {
      work: async (value: { i: number }) => {
        await work();
        return value;
      },
    },
    { name: "bench", worker: { concurrency: CONCURRENCY } }
  );
  const started = process.hrtime.bigint();
  await jobs.work.bulk(Array.from({ length: JOBS }, (_, i) => ({ i })));
  await jobs.worker.onIdle();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  await jobs.worker.close({ drain: false });
  return ms;
}

async function measure(
  label: string,
  run: () => Promise<number>
): Promise<number> {
  await run(); // warmup, discarded
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) samples.push(await run());
  const m = median(samples);
  const spread = samples.map((s) => Math.round(s)).join(", ");
  console.log(
    `  ${label.padEnd(34)} ${String(Math.round(m)).padStart(6)}ms   ` +
      `${rate(m).padStart(20)}   [${spread}]`
  );
  return m;
}

console.log(
  `\nThroughput: ${JOBS} jobs, concurrency ${CONCURRENCY}, ` +
    `median of ${RUNS} runs (warmup discarded)\n`
);
const bull = await measure("BullMQ (Redis)", bullmq);
const enqiuDefault = await measure("Enqiu Redis, default poll 100ms", () =>
  enqiuRedis(100)
);
const enqiuTuned = await measure("Enqiu Redis, poll 5ms", () => enqiuRedis(5));
const memory = await measure("Enqiu memory (no I/O)", enqiuMemory);

console.log("\nRelative to BullMQ on the same Redis:");
const ratio = (ms: number) =>
  ms < bull
    ? `${(bull / ms).toFixed(2)}x faster`
    : `${(ms / bull).toFixed(2)}x slower`;
console.log(`  Enqiu @100ms poll : ${ratio(enqiuDefault)}`);
console.log(`  Enqiu @5ms poll   : ${ratio(enqiuTuned)}`);
console.log(
  `  Enqiu memory      : ${ratio(memory)}  (no network — not a like-for-like comparison)\n`
);

process.exit(0);
