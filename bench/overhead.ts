/**
 * What does the wrapper cost?
 *
 * Enqiu is now a layer over BullMQ, so the only honest benchmark is against
 * raw BullMQ on the same Redis. Anything close to parity means the layer is
 * thin; a large gap would be overhead worth removing.
 *
 * Fairness rules: identical Redis, identical job count and concurrency, each
 * contestant in its own namespace flushed between runs, one warmup discarded,
 * median of N runs reported with the raw spread.
 *
 * Three contestants, because the cost splits in two places:
 *   - raw BullMQ                — the floor
 *   - Enqiu, bare handler       — the wrapper minus validation
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

const parsed = new globalThis.URL(URL);
const connection = {
  host: parsed.hostname,
  port: Number(parsed.port || 6379),
};

const work = async (): Promise<void> => {
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

/** The floor: BullMQ with no wrapper at all. */
async function rawBullmq(): Promise<number> {
  const prefix = "bench-raw";
  await flush(`${prefix}:`);
  const conn = new IORedis(URL as string, { maxRetriesPerRequest: null });
  const queue = new Queue("bench", { connection: conn, prefix });

  let done = 0;
  let finished!: () => void;
  const allDone = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const worker = new Worker(
    "bench",
    async (bull) => {
      await work();
      done += 1;
      if (done === JOBS) finished();
      return bull.data;
    },
    { connection: conn, prefix, concurrency: CONCURRENCY, autorun: false }
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
  await conn.quit();
  return ms;
}

async function viaEnqiu(
  validated: boolean,
  validatePayloads = true
): Promise<number> {
  const prefix = `bench-enqiu-${validated ? "zod" : "bare"}-${validatePayloads}`;
  await flush(`${prefix}:`);

  let done = 0;
  let finished!: () => void;
  const allDone = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const tick = async (value: { i: number }) => {
    await work();
    done += 1;
    if (done === JOBS) finished();
    return value;
  };

  const jobs = enqiu(
    validated
      ? { work: job({ input: z.object({ i: z.number() }), run: tick }) }
      : { work: tick },
    {
      name: "bench",
      connection,
      prefix,
      worker: { concurrency: CONCURRENCY, autoStart: false },
      validatePayloads,
    }
  );

  const started = process.hrtime.bigint();
  await jobs.work.bulk(Array.from({ length: JOBS }, (_, i) => ({ i })));
  await jobs.worker.start();
  await allDone;
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
  console.log(
    `  ${label.padEnd(26)} ${String(Math.round(m)).padStart(6)}ms   ` +
      `${rate(m).padStart(18)}   [${samples.map((s) => Math.round(s)).join(", ")}]`
  );
  return m;
}

console.log(
  `\nWrapper overhead: ${JOBS} jobs, concurrency ${CONCURRENCY}, ` +
    `${WORK_MS}ms work/job, median of ${RUNS}\n`
);
const raw = await measure("raw BullMQ", rawBullmq);
const bare = await measure("Enqiu (bare handler)", () => viaEnqiu(false));
const zod = await measure("Enqiu (Zod-validated)", () => viaEnqiu(true));
const lean = await measure("Enqiu (no payload check)", () =>
  viaEnqiu(false, false)
);

const overhead = (ms: number): string => {
  const pct = ((ms - raw) / raw) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
};
console.log("\nOverhead vs raw BullMQ:");
console.log(`  Enqiu (bare handler)     ${overhead(bare)}`);
console.log(`  Enqiu (Zod-validated)    ${overhead(zod)}`);
console.log(`  Enqiu (no payload check) ${overhead(lean)}\n`);

process.exit(0);
