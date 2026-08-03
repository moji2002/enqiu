import { copyFile, cp, mkdir, rm } from "node:fs/promises";

const publicDirectory = new URL("../public/", import.meta.url);
const enqiuPublicDirectory = new URL("../public/enqiu/", import.meta.url);

await mkdir(publicDirectory, { recursive: true });
await rm(enqiuPublicDirectory, { recursive: true, force: true });
await Promise.all([
  copyFile(
    new URL("../../docs/index.html", import.meta.url),
    new URL("../public/landing.html", import.meta.url),
  ),
  copyFile(
    new URL("../../docs/og.png", import.meta.url),
    new URL("../public/og.png", import.meta.url),
  ),
  copyFile(
    new URL("../../docs/queue-lab.js", import.meta.url),
    new URL("../public/queue-lab.js", import.meta.url),
  ),
  cp(
    new URL("../../dist/", import.meta.url),
    enqiuPublicDirectory,
    { recursive: true },
  ),
]);

console.log("Synced the Enqiu landing page and browser playground.");
