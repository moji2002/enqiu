import { copyFile, mkdir } from "node:fs/promises";

const publicDirectory = new URL("../public/", import.meta.url);

await mkdir(publicDirectory, { recursive: true });
await Promise.all([
  copyFile(
    new URL("../../docs/index.html", import.meta.url),
    new URL("../public/landing.html", import.meta.url),
  ),
  copyFile(
    new URL("../../docs/og.png", import.meta.url),
    new URL("../public/og.png", import.meta.url),
  ),
]);

console.log("Synced the upper Enqiu landing page.");
