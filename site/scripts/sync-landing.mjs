import { mkdir, rm } from "node:fs/promises";

const publicDirectory = new URL("../public/", import.meta.url);
const enqiuPublicDirectory = new URL("../public/enqiu/", import.meta.url);
const legacyAdminPublicDirectory = new URL("../public/admin/", import.meta.url);
const staleLandingFiles = ["landing.html", "landing.js", "landing.css", "landing.woff2", "landing2.woff2", "queue-lab.js", "index.html", "og.png"];

await mkdir(publicDirectory, { recursive: true });
await Promise.all([
  rm(enqiuPublicDirectory, { recursive: true, force: true }),
  rm(legacyAdminPublicDirectory, { recursive: true, force: true }),
  rm(new URL("../public/playground/", import.meta.url), { recursive: true, force: true }),
  ...staleLandingFiles.map((file) => rm(new URL(`../public/${file}`, import.meta.url), { force: true })),
]);

console.log("Prepared the Enqiu landing page.");
