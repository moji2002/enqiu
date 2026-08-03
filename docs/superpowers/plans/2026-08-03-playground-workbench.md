# Enqiu Playground Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the React admin with a complete `/playground` queue workbench powered by real Enqiu jobs, simplify the landing, and prepare a verified browser-support package release.

**Architecture:** The static landing keeps a small real ESM queue preview. A separate Vite React application owns a fresh in-tab Enqiu memory queue through a dedicated queue factory and hook, then renders a composer, event-driven queue list, and contextual inspector. Generated assets remain untracked and are recreated by the existing site build.

**Tech Stack:** TypeScript, React 19, Vite 8, Enqiu memory driver, CSS, Node test runner, Vitest, Vercel static output.

## Global Constraints

- The surface is called `Playground`, never `Admin`, `Dashboard`, or `Workspace`.
- Every job, statistic, log, progress value, and transition comes from the actual Enqiu memory driver.
- The browser queue is non-durable and resets when the tab closes or the user resets it.
- Redis is not initialized in the browser.
- The playground does not execute arbitrary JavaScript.
- No gradients, glass cards, fake terminal chrome, fabricated production metrics, or generic analytics dashboard tiles.
- Status is never communicated by color or motion alone.
- Reduced motion replaces transitions with immediate state changes.
- Do not commit, tag, push, deploy, or run `npm publish` without explicit user authorization.

---

### Task 1: Lock the route and artifact contract

**Files:**
- Modify: `site/tests/rendered-html.test.mjs`
- Modify: `site/worker/index.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: generated static assets in `site/public/`
- Produces: tests and routing contract for `/playground`; removal contract for `/admin`

- [ ] **Step 1: Replace the admin artifact test with a failing playground test**

Assert that `site/playground/main.tsx` imports `enqiu`, the generated HTML mounts
`#root`, `/playground/playground.js` is referenced, `render("/playground")`
returns 200, and `render("/admin")` returns 404.

```js
test("ships a React playground backed by real Enqiu state", async () => {
  const [source, html, response] = await Promise.all([
    readFile(new URL("../playground/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/playground/index.html", import.meta.url), "utf8"),
    render("/playground"),
  ]);

  assert.match(source, /from "enqiu"/);
  assert.match(source, /createRoot\(/);
  assert.match(html, /id="root"/);
  assert.match(html, /\/playground\/playground\.js/);
  assert.equal(response.status, 200);
  assert.equal((await render("/admin")).status, 404);
});
```

- [ ] **Step 2: Run the artifact test and confirm it fails**

Run: `node --test site/tests/rendered-html.test.mjs`

Expected: failure because `site/playground/main.tsx` and the playground artifact
do not exist and `/admin` still resolves.

- [ ] **Step 3: Change static routing**

In `site/worker/index.ts`, serve `/playground` and `/playground/` from
`/playground/index.html`; remove the `/admin` branch. In `vercel.json`, replace
the `/admin` rewrite with:

```json
{
  "source": "/playground",
  "destination": "/playground/index.html"
}
```

- [ ] **Step 4: Re-run the focused test**

Expected: the source/artifact checks still fail, while the route assertions
reflect the new contract.

---

### Task 2: Create the real playground queue model

**Files:**
- Create: `site/playground/types.ts`
- Create: `site/playground/queue.ts`
- Create: `test/playground.test.ts`
- Modify: `src/memory.ts`
- Modify: `src/api.ts`
- Modify: `test/api.test.ts`

**Interfaces:**
- Produces: `RecipeId`, `ComposerDraft`, `PlaygroundQueue`, `RECIPES`, `createPlaygroundQueue()`, `submitDraft()`
- Consumes: `enqiu`, `JobContext`, `SubmitOptions`, and public queue APIs

- [ ] **Step 1: Define shared playground types**

```ts
export type RecipeId = "sendEmail" | "resizeImage" | "syncAccount";

export interface ComposerDraft {
  recipe: RecipeId;
  payload: string;
  priority: "low" | "normal" | "high";
  delayMs: 0 | 2_000 | 5_000;
  retryAttempts: 1 | 2 | 3;
  timeoutMs?: number;
  expiresInMs?: number;
  customId?: string;
  idempotencyKey?: string;
  failOnce: boolean;
}

export interface Recipe {
  id: RecipeId;
  label: string;
  description: string;
  defaultPayload: Readonly<Record<string, unknown>>;
  supportsFailure: boolean;
}
```

- [ ] **Step 2: Write failing queue-model tests**

Cover:

1. all three recipes enqueue through the real queue;
2. malformed JSON rejects before queue creation;
3. delay creates a `scheduled` snapshot;
4. fail-once with two attempts succeeds on attempt 2 and retains logs;
5. cancellation changes a queued job to `cancelled`;
6. a failed job can be redriven;
7. custom priority and ID are visible in snapshots.
8. `queue.cleanup({ status: "succeeded" })` leaves failed and cancelled jobs
   untouched in the memory driver.

Run: `pnpm exec vitest run test/playground.test.ts`

Expected: failure because the model does not exist.

- [ ] **Step 3: Fix status-scoped cleanup in the memory driver**

Extend `CleanupOptions` with `status?: JobStatus | readonly JobStatus[]`, filter
terminal records against the normalized status set, and pass
`CleanupQuery.status` from the public memory facade. Add an API regression that
creates succeeded and cancelled jobs, cleans only succeeded, and proves the
cancelled snapshot remains.

- [ ] **Step 4: Implement `createPlaygroundQueue()`**

Create real typed handlers with deterministic timings under 1.6 seconds each.
Every delay must honor `context.signal`; every handler must emit logs and at
least two progress updates. `syncAccount` reads an internal `failOnce` input
field and throws only on attempt 1.

```ts
export function createPlaygroundQueue() {
  return enqiu(
    { sendEmail, resizeImage, syncAccount },
    { name: "playground", worker: { concurrency: 2 }, historyLimit: 80 },
  );
}
```

- [ ] **Step 5: Implement payload parsing and submission**

`submitDraft(queue, draft)` parses JSON, validates recipe-specific required
fields, maps priority/delay/retry/timeout/expiry/ID/idempotency options, and
returns the public `JobHandle`. Throw `PlaygroundInputError` with a precise
message for parsing or shape errors.

- [ ] **Step 6: Run the focused tests**

Run: `pnpm exec vitest run test/playground.test.ts`

Expected: all queue-model tests pass with no timers or workers left open.

---

### Task 3: Build the queue subscription hook

**Files:**
- Create: `site/playground/use-playground-queue.ts`

**Interfaces:**
- Consumes: `createPlaygroundQueue()`, `submitDraft()`, Enqiu queue events
- Produces: `usePlaygroundQueue()` with stable state and actions

- [ ] **Step 1: Define the hook result**

```ts
export interface PlaygroundState {
  jobs: JobSnapshot[];
  stats: QueueStats;
  selectedId?: string;
  paused: boolean;
  concurrency: 1 | 2 | 4;
  busyAction?: string;
  alert?: string;
}

export interface PlaygroundActions {
  enqueue(draft: ComposerDraft): Promise<void>;
  enqueueScenario(kind: "queue-three" | "fail-once" | "schedule-five"): Promise<void>;
  select(id: string): void;
  setPaused(paused: boolean): Promise<void>;
  setConcurrency(value: 1 | 2 | 4): Promise<void>;
  cancelSelected(): Promise<void>;
  redriveSelected(): Promise<void>;
  editSelected(): ComposerDraft | undefined;
  cleanup(scope: "succeeded" | "terminal"): Promise<void>;
  reset(): Promise<void>;
  clearAlert(): void;
}
```

- [ ] **Step 2: Implement event-driven refresh**

Create the queue lazily once. Subscribe to `added`, `started`, `progress`,
`succeeded`, `failed`, `cancelled`, and `expired`. Coalesce same-tick events into
one `Promise.all([queue.list({limit: 80}), queue.stats()])` refresh and use
`startTransition` for list/state updates.

- [ ] **Step 3: Implement stable actions and selection rules**

Select a newly created job. Preserve user selection for unrelated event
updates. Disable invalid operations by checking the latest selected snapshot
before calling cancel or redrive. Restore the composer draft through the
`editSelected()` return value rather than mutating composer state inside the
hook.

- [ ] **Step 4: Implement teardown and reset**

Unsubscribe every queue event and call `worker.close({ drain: false })` during
unmount. Reset must close the old queue, create a new instance, clear selection,
and publish a fresh empty state without reloading the page.

---

### Task 4: Build the composer

**Files:**
- Create: `site/playground/components/job-composer.tsx`
- Create: `site/playground/components/json-editor.tsx`

**Interfaces:**
- Consumes: `RECIPES`, `ComposerDraft`, enqueue actions
- Produces: accessible compose flow and scenario shortcuts

- [ ] **Step 1: Render recipe selection and seeded JSON**

Use three compact recipe buttons showing function name, short purpose, and one
capability label. Selecting a recipe replaces the payload only after it is
still unchanged from the previous recipe default; preserve user-edited input.

- [ ] **Step 2: Implement the JSON editor**

Use a labeled monospace `textarea`, line/column parse feedback, Format, and Copy.
Mirror the current draft to `sessionStorage` under
`enqiu.playground.composer.v1`; validate the stored shape before restoring it.

- [ ] **Step 3: Add common and advanced options**

Keep priority and delay visible. Place retry attempts, timeout, expiry, custom
ID, idempotency key, and fail-once under one native `details` disclosure. Hide
the fail-once option for recipes that do not support it.

- [ ] **Step 4: Add real scenario shortcuts**

`Queue three`, `Fail once`, and `Schedule +5s` call the same enqueue API as the
main form. Keep exactly one primary action: `Enqueue job`.

- [ ] **Step 5: Complete invalid and busy states**

Retain invalid input, focus the editor, and show a specific inline message.
Disable only the active enqueue action while acceptance is pending; never block
inspection or queue controls.

---

### Task 5: Build the live queue canvas and toolbar

**Files:**
- Create: `site/playground/components/queue-toolbar.tsx`
- Create: `site/playground/components/queue-canvas.tsx`
- Create: `site/playground/components/job-row.tsx`

**Interfaces:**
- Consumes: snapshots, stats, selection, worker controls
- Produces: compact live queue with exact Enqiu states

- [ ] **Step 1: Build the compact worker toolbar**

Show `running / limit`, Pause/Resume, concurrency 1/2/4, and a menu for Clear
completed, Clear terminal, and Reset playground. Reset requires an inline
confirmation popover with Cancel and Reset; do not use `window.confirm`.

- [ ] **Step 2: Build filters and search**

Add All, Active, Scheduled, Succeeded, Failed, and Stopped filters plus
job-name search. Show the visible result count and Clear filter only when a
filter or search is active.

- [ ] **Step 3: Build state-rich job rows**

Each row shows name, short ID, exact status text, progress, attempt, relative
time, and contextual priority/delay. Use `aria-current` for selection. Empty and
no-results states keep the composer accessible and provide one correct action.

- [ ] **Step 4: Add lifecycle motion**

Animate only transform, opacity, and a CSS custom-property progress track. New
queued jobs enter with a short spring-like cubic bezier; running gets one
continuous progress treatment; terminal states settle once. Disable all
transitions under `prefers-reduced-motion`.

- [ ] **Step 5: Add paused and saturation explanations**

The banner copy is exact: `Paused — queued jobs will wait; running jobs will
finish.` When `stats.running === concurrency && stats.queued > 0`, explain that
the worker limit is full.

---

### Task 6: Build the contextual job inspector

**Files:**
- Create: `site/playground/components/job-inspector.tsx`
- Create: `site/playground/components/lifecycle.tsx`
- Create: `site/playground/components/code-block.tsx`

**Interfaces:**
- Consumes: selected `JobSnapshot`, cancel/redrive/edit actions
- Produces: Overview/Input/Logs/Result-or-Error detail surface

- [ ] **Step 1: Build inspector identity and actions**

Show name, full ID with Copy, status, created time, duration, priority, and
attempt/retry facts. Render Cancel only for queued/scheduled/running; Redrive
only for failed/cancelled/expired; Run again and Edit as new job for terminal
jobs.

- [ ] **Step 2: Build accessible tabs**

Implement roving keyboard tabs for Overview, Input, Logs, and Result/Error.
Automatically select Error after a selected job transitions to failed, without
stealing focus.

- [ ] **Step 3: Build the lifecycle**

Derive created, scheduled/queued, started, progress, retry, and terminal events
from snapshot timestamps, attempt, progress, error, and logs. Never invent
timestamps. Omit stages without evidence.

- [ ] **Step 4: Render structured evidence**

Input/output/error use formatted code blocks with Copy. Logs display timestamp,
level, message, and expandable JSON fields. The empty Logs tab explains that
the selected handler has not emitted logs yet.

---

### Task 7: Compose the responsive React workbench

**Files:**
- Create: `site/playground/index.html`
- Create: `site/playground/main.tsx`
- Create: `site/playground/playground.css`
- Create: `site/playground.vite.config.ts`
- Delete: `site/admin/`
- Delete: `site/admin.vite.config.ts`

**Interfaces:**
- Consumes: composer, toolbar, canvas, inspector, hook
- Produces: generated `/playground/index.html`, `playground.js`, and `playground.css`

- [ ] **Step 1: Create the Vite entry and rename build output**

Use base `/playground/`, source root `site/playground/`, output
`site/public/playground/`, stable entry `playground.js`, and stable CSS
`playground.css`. Keep the `enqiu` alias pointed at `../src/index.ts`.

- [ ] **Step 2: Compose the desktop shell**

Header: Enqiu mark, `Playground`, `Real Enqiu · Memory`, Docs, Back to landing,
worker controls. Body: 340px composer, flexible queue, 390px inspector. The live
queue is visually dominant.

- [ ] **Step 3: Create the product-specific visual system**

Use warm near-white, ink, periwinkle, coral, and mint variables; editorial
display type plus monospace data type; thin rules; square-to-soft 10–14px
corners; no global card shadows. Job tokens and the worker gate are the only
signature illustration.

- [ ] **Step 4: Implement tablet and mobile behavior**

At 700–1099px, composer collapses above a jobs/inspector split. Below 700px,
show Compose and Jobs task tabs; selecting a job opens a full-screen detail
sheet with a visible Back control. Preserve draft and selection on resize. No
horizontal scrolling tables or multiple sticky toolbars.

- [ ] **Step 5: Add error boundary and live announcements**

Wrap the workbench in a class error boundary that preserves the session draft
and renders Reload/Reset recovery. Add one polite live region for accepted and
terminal transitions.

---

### Task 8: Simplify and reconnect the landing

**Files:**
- Modify: `docs/index.html`
- Modify: `docs/queue-lab.js`
- Modify: `site/tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: real compiled browser ESM preview
- Produces: concise landing linked to `/playground`

- [ ] **Step 1: Remove admin terminology and link the playground**

Replace the nav item with `Playground`. Add `Open playground` beside the hero
preview and after the compact feature proof. No `/admin` string may remain in
landing or site source.

- [ ] **Step 2: Reduce landing repetition**

Keep the hero, typed-handler proof, memory-to-Redis progression, one reliability
section, and final install CTA. Collapse advanced controls, recurring work,
feature matrix, and API inventory into one compact `What it handles` section.
Target five major sections after the hero rather than the current ten.

- [ ] **Step 3: Improve hero preview hierarchy**

Keep the one-job real queue run but show clearer queued/working/result states,
one prominent Run button, and a secondary Open playground link. Remove visual
elements that do not change with actual queue state.

- [ ] **Step 4: Update artifact assertions**

Assert that the landing contains `/playground`, has no `/admin`, still imports
`/queue-lab.js`, and that queue-lab imports `/enqiu/index.js` and subscribes to
real lifecycle events.

---

### Task 9: Update build scripts and generated-artifact rules

**Files:**
- Modify: `site/package.json`
- Modify: `site/scripts/sync-landing.mjs`
- Modify: `.gitignore`
- Modify: `site/tsconfig.json`

**Interfaces:**
- Produces: one reproducible build for landing + browser ESM + React playground

- [ ] **Step 1: Rename scripts**

Replace `build:admin` with `build:playground`; make `build:landing` compile the
root package, sync the landing, then run the new playground build.

- [ ] **Step 2: Update generated paths**

Ignore `site/public/playground/` instead of `site/public/admin/`. Ensure the sync
script does not leave stale admin assets; explicitly remove both generated
directories before copying/building during the transition.

- [ ] **Step 3: Run the site checks**

Run:

```text
npm run lint
npx tsc --noEmit
npm test
```

Expected: all lint, TypeScript, build, route, and artifact checks pass.

---

### Task 10: Prepare browser-support release 0.1.3

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Produces: packable `enqiu@0.1.3` with browser export and release notes

- [ ] **Step 1: Confirm version availability**

Run: `npm view enqiu@0.1.3 version`

Expected: registry 404/not found. Do not continue if the version exists.

- [ ] **Step 2: Bump metadata without Git mutation**

Use a direct patch to set `version` to `0.1.3` in `package.json` and the root
lockfile importer/package snapshot. Do not run `npm version` because it creates
a commit and tag by default.

- [ ] **Step 3: Finalize release notes**

Move the current Unreleased browser-export and strict-handler fixes under
`0.1.3 - 2026-08-03`. State that browser memory queues are in-tab and
non-durable; do not imply browser Redis support.

- [ ] **Step 4: Verify packed contents**

Run with a writable temporary cache:

```text
env npm_config_cache=/tmp/enqiu-npm-cache npm pack --dry-run
```

Expected: package name/version `enqiu@0.1.3`, compiled ESM/declarations present,
README/CHANGELOG present, no site source or generated playground bundle.

- [ ] **Step 5: Do not publish without authorization**

Registry mutation requires the user to explicitly authorize `npm publish`.
When authorized, run `npm publish --access public`, then verify `npm view enqiu`
shows version `0.1.3`, the browser description, and browser export.

---

### Task 11: Full verification and publication handoff

**Files:**
- Verify all changed files

**Interfaces:**
- Produces: evidence that local and production behavior satisfy the spec

- [ ] **Step 1: Run package verification**

Run: `pnpm run check`

Expected: all typechecks, unit tests, and build pass; only configured Redis
integration tests may remain skipped.

- [ ] **Step 2: Run a local production site build**

Run: `vercel build --yes --prod`

Expected: `.vercel/output/static/playground/` contains HTML, JS, and CSS;
`static/admin/` does not exist; routes include `/playground` and `/`.

- [ ] **Step 3: Browser-test every required workflow**

At 1440×1000, 900×1000, and 390×844 verify:

- valid enqueue and selected inspector;
- invalid JSON retains input and creates no job;
- paused queue holds waiting work and resumes it;
- concurrency 1 and Queue three visibly serialize work;
- scheduled +5s stays scheduled before running;
- running job cancellation;
- fail once reaches attempt 2 and succeeds;
- terminal failure followed by Redrive;
- Clear completed and Reset;
- mobile Compose → Jobs → Detail navigation;
- no console errors or horizontal overflow;
- reduced-motion state remains legible.

- [ ] **Step 4: Visually review screenshots**

Inspect landing and playground at all three viewports. Correct clipped text,
misaligned controls, accidental empty space, weak hierarchy, generic card
patterns, and misleading state copy before completion.

- [ ] **Step 5: Inspect final Git state**

Run `git diff --check` and `git status --short --branch`. Do not stage or commit
without explicit authorization.

- [ ] **Step 6: Publish only after authorization**

When explicitly authorized, commit and push the scoped changes, wait for the
Vercel Git deployment, then repeat the production route, browser workflow,
console, and mobile overflow checks on `https://enqiu.worksonmy.dev`.
