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
            pathname === "/landing.html"
              ? "landing.html"
              : pathname === "/admin/index.html"
                ? "admin/index.html"
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
  assert.match(html, /Memory \+ Redis/);
  assert.match(html, /04 · Hono/);
  assert.match(html, /id="queue-lab"/);
  assert.match(html, /id="run-job"/);
  assert.match(html, /id="job-status"/);
  assert.match(html, /data-stage="queued"/);
  assert.match(html, /<script type="module" src="\/queue-lab\.js"><\/script>/);
  assert.match(html, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /id="event-list"|id="fail-next"|queue-lane/);
  assert.doesNotMatch(html, /const stages =/);
  assert.doesNotMatch(html, /API proposal|Confirmation point|codex-preview/i);
});

test("runs the playground with the actual Enqiu browser module", async () => {
  const [source, packageJson, readme] = await Promise.all([
    readFile(new URL("../../docs/queue-lab.js", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../README.md", import.meta.url), "utf8"),
  ]);
  const packageMetadata = JSON.parse(packageJson);

  assert.match(source, /import \{ enqiu \} from "\.\/enqiu\/index\.js"/);
  assert.match(source, /enqiu\(\s*\{/);
  assert.match(source, /jobs\.queue\.on\("added"/);
  assert.match(source, /jobs\.queue\.on\("started"/);
  assert.match(source, /jobs\.queue\.on\("progress"/);
  assert.match(source, /jobs\.queue\.on\("succeeded"/);
  assert.equal(packageMetadata.browser, "./dist/index.js");
  assert.equal(packageMetadata.exports["."].browser, "./dist/index.js");
  assert.match(packageMetadata.description, /browsers, Node\.js, and Bun/);
  assert.match(readme, /memory driver runs in modern browsers/i);
});

test("ships a React admin backed by Enqiu queue state", async () => {
  const [source, adminHtml, response] = await Promise.all([
    readFile(new URL("../admin/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/admin/index.html", import.meta.url), "utf8"),
    render("/admin"),
  ]);

  assert.match(source, /import\s*\{\s*enqiu/);
  assert.match(source, /from "enqiu"/);
  assert.match(source, /jobs\.queue\.stats\(\)/);
  assert.match(source, /jobs\.queue\.list\(/);
  assert.match(source, /createRoot\(/);
  assert.match(adminHtml, /id="root"/);
  assert.match(adminHtml, /\/admin\/admin\.js/);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="root"/);
});

test("keeps one landing source and removes starter-only assets", async () => {
  const [
    upperLanding,
    deployedLanding,
    upperPlayground,
    deployedPlayground,
    packageJson,
    worker,
  ] =
    await Promise.all([
      readFile(new URL("../../docs/index.html", import.meta.url), "utf8"),
      readFile(new URL("../public/landing.html", import.meta.url), "utf8"),
      readFile(new URL("../../docs/queue-lab.js", import.meta.url), "utf8"),
      readFile(new URL("../public/queue-lab.js", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    ]);

  assert.equal(deployedLanding, upperLanding);
  assert.equal(deployedPlayground, upperPlayground);
  assert.match(packageJson, /"sync:landing"/);
  assert.match(packageJson, /"build:landing"/);
  assert.match(worker, /"\/landing\.html"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await access(new URL("../public/enqiu/index.js", import.meta.url));

  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});
