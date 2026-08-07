/**
 * What does the wrapper cost?
 *
 * Enqiu is now a layer over BullMQ, so the only honest benchmark is against
 * raw BullMQ on the same Redis. Anything close to parity means the layer is
 * thin; a large gap would be overhead worth removing.
 *
 * Fairness rules: identical Redis, identical connection handling, identical job
 * count and concurrency, each contestant in its own namespace flushed between
 * runs, every contestant warmed before anything is measured, and the runs
 * interleaved so no one absorbs the warmup on everyone else's behalf. Median of
 * N reported with the raw spread.
 *
 * Three contestants, because the cost splits in two places:
 *   - raw BullMQ                — the floor
 *   - Enqiu, bare handler       — the wrapper minus schema validation
 *   - Enqiu, Zod-validated      — what most callers actually write
 */

import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { enqiu, job } from "../src/index.js";

const URL = process.env.ENQIU_TEST_REDIS_URL;
if (!URL) {
  console.error("Set ENQIU_TEST_REDIS_URL to run the benchmark.");
  process.exit(1);
}

const JOBS = Number(process.env.BENCH_JOBS ?? 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 32);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const WORK_MS = Number(process.env.BENCH_WORK_MS ?? 0);

const connection = { url: URL };

const work = async (): Promise<void> => {
  if (WORK_MS > 0) await new Promise((r) => setTimeout(r, WORK_MS));
};

/** Both contestants finish the same way: count to JOBS, then resolve. */
function latch(): { tick: () => void; allDone: Promise<void> } {
  let done = 0;
  let finished!: () => void;
  const allDone = new Promise<void>((resolve) => {
    finished = resolve;
  });
  return {
    tick: () => {
      done += 1;
      if (done === JOBS) finished();
    },
    allDone,
  };
}

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

/**
 * The floor: BullMQ with no wrapper at all.
 *
 * Both contestants hand BullMQ the same connection *options* rather than a
 * shared client. Passing one ioredis instance to both Queue and Worker made
 * the floor look slower than the thing built on top of it — the worker's
 * blocking reads contend with the producer on that single socket, which is a
 * property of how it was wired up, not of the wrapper.
 */
async function rawBullmq(): Promise<number> {
  const prefix = "bench-raw";
  await flush(`${prefix}:`);
  const queue = new Queue("bench", { connection, prefix });

  const { tick, allDone } = latch();
  const worker = new Worker(
    "bench",
    async (bull) => {
      await work();
      tick();
      return bull.data;
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

  await Promise.all([worker.close(), queue.close()]);
  return ms;
}

async function viaEnqiu(validated: boolean): Promise<number> {
  const prefix = `bench-enqiu-${validated ? "zod" : "bare"}`;
  await flush(`${prefix}:`);

  const { tick, allDone } = latch();
  const run = async (value: { i: number }) => {
    await work();
    tick();
    return value;
  };

  const { jobs, worker, close } = enqiu(
    validated
      ? { work: job({ input: z.object({ i: z.number() }), run }) }
      : { work: run },
    {
      name: "bench",
      connection,
      prefix,
      worker: { concurrency: CONCURRENCY, autoStart: false },
    }
  );

  const started = process.hrtime.bigint();
  await jobs.work.bulk(Array.from({ length: JOBS }, (_, i) => ({ i })));
  await worker.start();
  await allDone;
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  await close({ drain: false });
  return ms;
}

const contestants = [
  { label: "raw BullMQ", run: rawBullmq },
  { label: "Enqiu (bare handler)", run: () => viaEnqiu(false) },
  { label: "Enqiu (Zod-validated)", run: () => viaEnqiu(true) },
];

console.log(
  `\nWrapper overhead: ${JOBS} jobs, concurrency ${CONCURRENCY}, ` +
    `${WORK_MS}ms work/job, median of ${RUNS}, interleaved\n`
);

// Warm every contestant, then interleave the measured runs. Measuring one to
// completion before starting the next let whoever went first absorb the JIT
// and connection warmup and read slower for it — by enough to make the wrapper
// look faster than the thing it wraps, which it cannot be.
const results = contestants.map((c) => ({ label: c.label, samples: [] as number[] }));
for (const contestant of contestants) await contestant.run();
for (let round = 0; round < RUNS; round += 1) {
  for (const [index, contestant] of contestants.entries()) {
    results[index]?.samples.push(await contestant.run());
  }
}

const medians = results.map((r) => ({ label: r.label, ms: median(r.samples) }));
for (const [index, { label, ms }] of medians.entries()) {
  const samples = results[index]?.samples ?? [];
  console.log(
    `  ${label.padEnd(26)} ${String(Math.round(ms)).padStart(6)}ms   ` +
      `${rate(ms).padStart(18)}   [${samples.map((s) => Math.round(s)).join(", ")}]`
  );
}

const raw = medians[0]?.ms ?? 0;
console.log("\nOverhead vs raw BullMQ:");
for (const { label, ms } of medians.slice(1)) {
  const pct = ((ms - raw) / raw) * 100;
  console.log(`  ${label.padEnd(26)} ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
}
console.log();

process.exit(0);
