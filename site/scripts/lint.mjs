import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const eslintBinary = fileURLToPath(new URL("../node_modules/.bin/eslint", import.meta.url));
const result = spawnSync(
  eslintBinary,
  [
    "--config",
    "site/eslint.config.mjs",
    "site",
    "docs/landing.tsx",
    "docs/use-landing-queue.ts",
    "--ignore-pattern",
    "site/dist",
    "--ignore-pattern",
    "site/.next",
    "--ignore-pattern",
    "site/public",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
