/**
 * Runs every scenario in order and fails the process if any check fails.
 *
 * Set ENQIU_TEST_REDIS_URL to also run the driver-parity scenarios (1 and 2)
 * against Redis with the identical job code.
 */

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const scenarios = readdirSync(here)
  .filter((name) => /^\d\d-.*\.ts$/.test(name))
  .sort();

const failures = [];
const started = Date.now();

for (const scenario of scenarios) {
  const code = await new Promise((resolve) => {
    spawn("npx", ["tsx", join(here, scenario)], { stdio: "inherit", shell: process.platform === "win32" })
      .on("close", resolve);
  });
  if (code !== 0) failures.push(scenario);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
process.stdout.write(
  `\n${"=".repeat(64)}\n` +
    `${scenarios.length} scenarios, ${failures.length} failed, ${seconds}s\n`
);
if (failures.length > 0) {
  process.stdout.write(`failed: ${failures.join(", ")}\n`);
  process.exitCode = 1;
}
