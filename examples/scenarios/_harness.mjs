/**
 * Shared plumbing for the scenario scripts.
 *
 * Each scenario is a runnable demonstration that also checks itself: `expect`
 * throws on a wrong result, so `node examples/scenarios/0N-*.mjs` exiting 0 is
 * a real signal, not just "it printed something".
 */

const GREY = "[90m";
const GREEN = "[32m";
const RED = "[31m";
const BOLD = "[1m";
const OFF = "[0m";

export function heading(title, subtitle) {
  process.stdout.write(`\n${BOLD}${title}${OFF}\n`);
  if (subtitle) process.stdout.write(`${GREY}${subtitle}${OFF}\n`);
  process.stdout.write(`${GREY}${"-".repeat(64)}${OFF}\n`);
}

export function step(message) {
  process.stdout.write(`  ${message}\n`);
}

export function note(message) {
  process.stdout.write(`  ${GREY}${message}${OFF}\n`);
}

let checks = 0;

export function expect(condition, description) {
  checks += 1;
  if (condition) {
    process.stdout.write(`  ${GREEN}ok${OFF}   ${description}\n`);
    return;
  }
  process.stdout.write(`  ${RED}FAIL${OFF} ${description}\n`);
  throw new Error(`Scenario check failed: ${description}`);
}

export function summary(name) {
  process.stdout.write(
    `\n${GREEN}${name}: ${checks} checks passed${OFF}\n`
  );
  checks = 0;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the driver options for a scenario. Scenarios that support both
 * backends call this so the same code runs against memory and Redis.
 */
export async function driverOptions(redisUrl, prefix) {
  if (!redisUrl) return { options: {}, close: async () => {} };

  const { createClient } = await import("redis");
  const { redis } = await import("../../dist/index.js");
  const client = createClient({ url: redisUrl });
  await client.connect();

  return {
    options: {
      driver: redis(client, { prefix, pollInterval: 5 }),
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

export function backends() {
  const url = process.env.ENQIU_TEST_REDIS_URL;
  return url ? ["memory", "redis"] : ["memory"];
}
