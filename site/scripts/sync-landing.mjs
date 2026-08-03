import { copyFile, cp, mkdir, rm } from "node:fs/promises";

const publicDirectory = new URL("../public/", import.meta.url);
const enqiuPublicDirectory = new URL("../public/enqiu/", import.meta.url);
const legacyAdminPublicDirectory = new URL("../public/admin/", import.meta.url);
const staleLandingFiles = ["landing.html", "landing.js", "landing.css", "queue-lab.js", "index.html"];

await mkdir(publicDirectory, { recursive: true });
await Promise.all([
  rm(enqiuPublicDirectory, { recursive: true, force: true }),
  rm(legacyAdminPublicDirectory, { recursive: true, force: true }),
  ...staleLandingFiles.map((file) => rm(new URL(`../public/${file}`, import.meta.url), { force: true })),
]);
await Promise.all([
  copyFile(
    new URL("../../docs/og.png", import.meta.url),
    new URL("../public/og.png", import.meta.url),
  ),
  cp(
    new URL("../../dist/", import.meta.url),
    enqiuPublicDirectory,
    { recursive: true },
  ),
]);

console.log("Synced the Enqiu landing page and browser playground.");
