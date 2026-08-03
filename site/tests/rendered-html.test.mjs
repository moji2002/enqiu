import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const publicRoot = new URL("../public/", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`https://enqiu.example${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          const asset =
            pathname === "/index.html"
              ? "index.html"
              : pathname === "/playground/index.html"
                ? "playground/index.html"
                : undefined;
          if (!asset) {
            return new Response("Not found", { status: 404 });
          }
          return new Response(
            await readFile(new URL(asset, publicRoot)),
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        },
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("serves the upper Enqiu landing page at the site root", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Enqiu — Queues without ceremony<\/title>/i);
  assert.match(html, /Background jobs,[\s\S]*called like functions\./);
  assert.match(html, /pnpm add enqiu/);
  assert.match(html, /jobs\.<span class="token-call">sendEmail/);
  assert.match(html, /Start local\. Add durability without rewriting jobs\./);
  assert.match(html, /04 · Reliability contract/);
  assert.match(html, /href="\/playground"/);
  assert.match(html, /id="queue-lab"/);
  assert.match(html, /id="run-job"/);
  assert.match(html, /id="job-status"/);
  assert.match(html, /data-stage="queued"/);
  assert.match(html, /<script type="module"[^>]+src="\/landing\.js"><\/script>/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /id="event-list"|id="fail-next"|queue-lane/);
  assert.doesNotMatch(html, /href="\/admin"|>Admin</i);
  assert.doesNotMatch(html, /const stages =/);
  assert.doesNotMatch(html, /API proposal|Confirmation point|codex-preview/i);
});

test("runs the React landing preview with the actual Enqiu browser module", async () => {
  const [source, landingSource, packageJson, readme] = await Promise.all([
    readFile(new URL("../../docs/use-landing-queue.ts", import.meta.url), "utf8"),
    readFile(new URL("../../docs/landing.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../README.md", import.meta.url), "utf8"),
  ]);
  const packageMetadata = JSON.parse(packageJson);

  assert.match(source, /from "enqiu"/);
  assert.match(source, /enqiu\(\s*\{/);
  assert.match(source, /queue\.on\("added"/);
  assert.match(source, /queue\.on\("started"/);
  assert.match(source, /queue\.on\("progress"/);
  assert.match(source, /queue\.on\("succeeded"/);
  assert.match(landingSource, /createRoot\(/);
  assert.doesNotMatch(landingSource, /querySelector|addEventListener/);
  assert.equal(packageMetadata.browser, "./dist/index.js");
  assert.equal(packageMetadata.exports["."].browser, "./dist/index.js");
  assert.match(packageMetadata.description, /browsers, Node\.js, and Bun/);
  assert.match(readme, /memory driver runs in modern browsers/i);
});

test("ships a React playground backed by Enqiu queue state", async () => {
  const [source, queueSource, playgroundHtml, response, oldAdmin] = await Promise.all([
    readFile(new URL("../playground/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../playground/queue.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/playground/index.html", import.meta.url), "utf8"),
    render("/playground"),
    render("/admin"),
  ]);

  assert.match(queueSource, /from "enqiu"/);
  assert.match(queueSource, /createPlaygroundQueue/);
  assert.match(queueSource, /reportProgress/);
  assert.match(source, /createRoot\(/);
  assert.match(playgroundHtml, /id="root"/);
  assert.match(playgroundHtml, /\/playground\/playground\.js/);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="root"/);
  assert.equal(oldAdmin.status, 404);
});

test("keeps one landing source and removes starter-only assets", async () => {
  const [
    landingEntry,
    landingSource,
    deployedLanding,
    packageJson,
    worker,
  ] =
    await Promise.all([
      readFile(new URL("../../docs/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../docs/landing.tsx", import.meta.url), "utf8"),
      readFile(new URL("../public/index.html", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    ]);

  assert.match(landingEntry, /id="root"/);
  assert.match(landingEntry, /src="\/landing\.tsx"/);
  assert.match(landingSource, /function LandingApp/);
  assert.match(deployedLanding, /src="\/landing\.js"/);
  assert.match(packageJson, /"sync:landing"/);
  assert.match(packageJson, /"build:landing-ui"/);
  assert.match(packageJson, /"build:landing"/);
  assert.match(worker, /"\/index\.html"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await access(new URL("../public/enqiu/index.js", import.meta.url));

  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});
