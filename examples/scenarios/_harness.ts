/**
 * Shared plumbing for the scenario scripts.
 *
 * Each scenario is a runnable demonstration that also checks itself: `expect`
 * throws on a wrong result, so a scenario exiting 0 is a real signal rather
 * than "it printed something".
 *
 * Every scenario needs Redis, because Enqiu is a layer over BullMQ.
 */

import { randomUUID } from "node:crypto";
import { enqiu } from "../../src/index.js";
import type {
  EnqiuOptions,
  JobDefinitions,
  JobsApi,
} from "../../src/index.js";

const GREY = "[90m";
const GREEN = "[32m";
const RED = "[31m";
const BOLD = "[1m";
const OFF = "[0m";

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

export function requireRedis(): { host: string; port: number } {
  const url = process.env.ENQIU_TEST_REDIS_URL;
  if (!url) {
    process.stdout.write(
      "  Set ENQIU_TEST_REDIS_URL to run the scenarios; Enqiu runs on BullMQ.\n"
    );
    process.exit(0);
  }
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

/** A queue in its own namespace, so scenarios never see each other's jobs. */
export function makeJobs<const Definitions extends JobDefinitions>(
  definitions: Definitions,
  overrides: Partial<Omit<EnqiuOptions, "connection">> = {}
): JobsApi<Definitions> {
  return enqiu(definitions, {
    name: `scenario-${randomUUID()}`,
    connection: requireRedis(),
    prefix: `enqiu-scenario:${randomUUID()}`,
    ...overrides,
  });
}
