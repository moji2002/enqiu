import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const publicRoot = new URL("../public/", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://enqiu.example/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const pathname = new URL(request.url).pathname;
          if (pathname !== "/landing.html") {
            return new Response("Not found", { status: 404 });
          }
          return new Response(
            await readFile(new URL("landing.html", publicRoot)),
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
  assert.match(html, /Queues without/);
  assert.match(html, /pnpm add enqiu/);
  assert.match(html, /jobs\.<span class="token-call">sendEmail/);
  assert.match(html, /Memory \+ Redis/);
  assert.match(html, /04 · Hono/);
  assert.match(html, /id="playground"/);
  assert.match(html, /id="enqueue-job"/);
  assert.match(html, /const advanceQueue/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /API proposal|Confirmation point|codex-preview/i);
});

test("keeps one landing source and removes starter-only assets", async () => {
  const [upperLanding, deployedLanding, packageJson, worker] =
    await Promise.all([
      readFile(new URL("../../docs/index.html", import.meta.url), "utf8"),
      readFile(new URL("../public/landing.html", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    ]);

  assert.equal(deployedLanding, upperLanding);
  assert.match(packageJson, /"sync:landing"/);
  assert.match(worker, /"\/landing\.html"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});
