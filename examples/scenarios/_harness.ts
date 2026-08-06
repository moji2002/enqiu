/**
 * Shared plumbing for the scenario scripts.
 *
 * Each scenario is a runnable demonstration that also checks itself: `expect`
 * throws on a wrong result, so a scenario exiting 0 is a real signal rather
 * than "it printed something".
 */

import { enqiu } from "../../src/index.js";
import type {
  DriverEnqiuOptions,
  JobDefinitions,
  JobsApi,
  MemoryEnqiuOptions,
  SharedEnqiuOptions,
  WorkerOptions,
} from "../../src/index.js";

const GREY = "[90m";
const GREEN = "[32m";
const RED = "[31m";
const BOLD = "[1m";
const OFF = "[0m";

export function heading(title: string, subtitle?: string): void {
  process.stdout.write(`\n${BOLD}${title}${OFF}\n`);
  if (subtitle) process.stdout.write(`${GREY}${subtitle}${OFF}\n`);
  process.stdout.write(`${GREY}${"-".repeat(64)}${OFF}\n`);
}

export function step(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

export function note(message: string): void {
  process.stdout.write(`  ${GREY}${message}${OFF}\n`);
}

let checks = 0;

export function expect(condition: boolean, description: string): void {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ${GREEN}ok${OFF}   ${description}\n`);
    return;
  }
  process.stdout.write(`  ${RED}FAIL${OFF} ${description}\n`);
  throw new Error(`Scenario check failed: ${description}`);
}

export function summary(name: string): void {
  process.stdout.write(`\n${GREEN}${name}: ${checks} checks passed${OFF}\n`);
  checks = 0;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type Backend = "memory" | "redis";

/**
 * Either an empty object (memory, the default driver) or a fully specified
 * Redis driver. `EnqiuOptions` is a union, so `Partial<>` of it is meaningless.
 */
export type ScenarioOptions =
  | Record<string, never>
  | { driver: DriverEnqiuOptions["driver"]; worker: false | WorkerOptions };

export interface ScenarioDriver {
  options: ScenarioOptions;
  close(): Promise<void>;
}

/**
 * Builds the driver options for a scenario. Scenarios that support both
 * backends call this so the identical job code runs against each.
 */
export async function driverOptions(
  redisUrl: string | undefined,
  prefix: string
): Promise<ScenarioDriver> {
  if (!redisUrl) return { options: {}, close: async () => {} };

  const { createClient } = await import("redis");
  const { redis } = await import("../../src/index.js");
  const client = createClient({ url: redisUrl });
  await client.connect();

  return {
    options: {
      driver: redis(client as never, { prefix, pollInterval: 5 }),
      worker: { concurrency: 8 },
    },
    close: async () => {
      for await (const keys of client.scanIterator({
        MATCH: `${prefix}:*`,
        COUNT: 100,
      })) {
        if (keys.length > 0) await client.del(keys);
      }
      await client.quit();
    },
  };
}

export function backends(): Backend[] {
  return process.env.ENQIU_TEST_REDIS_URL ? ["memory", "redis"] : ["memory"];
}

/**
 * Builds a queue for whichever backend the scenario is running against.
 *
 * `enqiu()` is overloaded on whether `driver` is present, and TypeScript will
 * not distribute a union across overloads, so the branch lives here once
 * rather than in every scenario.
 */
export function makeJobs<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  driver: ScenarioDriver,
  overrides: Partial<SharedEnqiuOptions> & {
    worker?: false | WorkerOptions;
  } = {}
): JobsApi<Definitions> {
  const base = driver.options;
  if ("driver" in base) {
    return enqiu(definitions, {
      ...base,
      ...overrides,
    } as DriverEnqiuOptions);
  }
  return enqiu(definitions, overrides as MemoryEnqiuOptions);
}
