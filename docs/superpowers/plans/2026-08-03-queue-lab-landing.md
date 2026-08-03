# Queue Lab Landing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current dashboard-like landing hero with a clear, mature Queue Lab experience centered on one animated job lifecycle.

**Architecture:** Keep `docs/index.html` as the canonical deployable landing source and `site/public/landing.html` as its generated copy. Load the compiled Enqiu ESM output in `docs/queue-lab.js` so the playground is driven by real memory-queue events. Build a separate React SPA into `site/public/admin/` for the live queue admin while preserving the detailed documentation sections and their existing tab/copy behavior.

**Tech Stack:** Semantic HTML, CSS, dependency-free browser JavaScript, Node test runner, Vinext/Vite build.

## Global Constraints

- The first viewport contains a direct product explanation, install action, docs link, and one Queue Lab.
- Use `#13131A`, `#F8F7FC`, `#FFFFFF`, `#5267F7`, `#F0715C`, and `#36A77A` as the visual token foundation.
- Remove the multi-lane board, event stream, failure toggle, trust-card grid, and playground footer.
- Preserve the existing detailed documentation, anchors, code tabs, and copy interactions.
- Respect `prefers-reduced-motion`, visible keyboard focus, minimum 44-pixel controls, and polite status announcements.
- Do not add package runtime dependencies; the admin may use the site's existing React toolchain.
- Do not commit or push without explicit user permission.

---

### Task 1: Lock the new landing contract

**Files:**
- Modify: `site/tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: generated `site/public/landing.html`
- Produces: assertions for the Queue Lab structure and removal of obsolete controls

- [ ] **Step 1: Replace the old hero assertions with the new contract**

```js
assert.match(html, /Background jobs, called like functions\./);
assert.match(html, /id="queue-lab"/);
assert.match(html, /id="run-job"/);
assert.match(html, /id="job-status"/);
assert.match(html, /data-stage="queued"/);
assert.match(html, /const runJob/);
assert.doesNotMatch(html, /id="event-list"|id="fail-next"|queue-lane/);
```

- [ ] **Step 2: Run the focused test and confirm it fails against the old landing**

Run: `cd site && npm run sync:landing && node --test tests/rendered-html.test.mjs`

Expected: the first test fails because the new headline and Queue Lab IDs are absent.

### Task 2: Rebuild the hero and Queue Lab

**Files:**
- Modify: `docs/index.html`

**Interfaces:**
- Consumes: `#run-job`, `#queue-reset`, `[data-stage]`, `#job-status`, `#job-result`
- Produces: `runJob()`, `resetLab()`, deterministic `queued → working → complete` state changes

- [ ] **Step 1: Replace the landing-specific CSS**

Define a compact Queue Lab theme and responsive composition. The desktop hero is a 5/7 split with copy on the left and a white lab surface on the right. On mobile it becomes one column. The only ambient motion is the job token moving between lifecycle stops; the working state may pulse and progress, while reduced-motion mode applies final states immediately.

```css
.hero-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(32rem, 7fr); }
.queue-track { display: grid; grid-template-columns: repeat(3, 1fr); }
.job-token { transform: translateX(var(--job-x)); transition: transform 520ms var(--queue-ease); }
@media (prefers-reduced-motion: reduce) { .job-token { transition: none; } }
```

- [ ] **Step 2: Replace the hero markup**

Use one headline, one support paragraph, an install control, a docs link, three inline proof points, and this state model:

```html
<section class="queue-lab" id="queue-lab" aria-labelledby="lab-title">
  <div class="queue-track" aria-hidden="true">
    <span data-stage="queued">Queued</span>
    <span data-stage="working">Working</span>
    <span data-stage="complete">Complete</span>
  </div>
  <article class="job-token" id="job-token" data-state="idle">
    <strong>sendEmail</strong>
    <span id="job-status">Ready to run</span>
  </article>
  <output id="job-result" aria-live="polite"></output>
  <button id="run-job" type="button">Run sendEmail()</button>
  <button id="queue-reset" type="button">Reset</button>
</section>
```

- [ ] **Step 3: Replace the multi-job controller**

Implement a cancellable lifecycle around a real paused Enqiu memory worker so
the queued state is visible before the worker starts. Subscribe to actual queue
events and use them as the only source of lifecycle state.

```js
const jobs = enqiu({ sendEmail }, { worker: false });
jobs.queue.on("added", showQueued);
jobs.queue.on("started", showWorking);
jobs.queue.on("progress", showProgress);
jobs.queue.on("succeeded", showResult);
```

- [ ] **Step 4: Sync and rerun the focused contract test**

Run: `cd site && npm run sync:landing && node --test tests/rendered-html.test.mjs`

Expected: both rendered HTML tests pass.

### Task 3: Build the React queue admin

**Files:**
- Create: `site/admin/index.html`
- Create: `site/admin/main.tsx`
- Create: `site/admin/admin.css`
- Create: `site/admin.vite.config.ts`
- Modify: `site/package.json`
- Modify: `site/worker/index.ts`
- Modify: `vercel.json`

**Interfaces:**
- Consumes: `enqiu()`, `queue.list()`, `queue.stats()`, queue lifecycle events,
  worker controls, and cleanup/concurrency APIs
- Produces: a static React SPA at `/admin` backed by a real per-tab memory queue

- [ ] **Step 1: Add the React admin build contract**

Assert that the source imports `enqiu`, reads real queue state, mounts through
`createRoot()`, and emits `/admin/admin.js` in the generated HTML.

- [ ] **Step 2: Implement the live admin**

Create real `sendEmail`, `resizeImage`, and `syncAccount` handlers. Subscribe to
their events and render queue statistics, job progress, inputs, results, and
logs. Add enqueue, pause/resume, concurrency, filter, and cleanup controls.

- [ ] **Step 3: Route both hosts to the static React artifact**

Build the SPA into `site/public/admin/`, add the Vercel rewrite, and serve the
same artifact from the Sites worker at `/admin`.

- [ ] **Step 4: Verify the production artifact**

Run: `npm --prefix site run build:landing && node --test site/tests/rendered-html.test.mjs`

Expected: the React bundle builds and all rendered artifact tests pass.

### Task 4: Visual QA and production readiness

**Files:**
- Modify if defects are found: `docs/index.html`
- Generated: `site/public/landing.html`

**Interfaces:**
- Consumes: built site root at desktop and mobile viewports
- Produces: verified responsive, accessible landing artifact

- [ ] **Step 1: Run static checks and a production build**

Run: `cd site && npm run lint && npm test`

Expected: ESLint, Vinext production build, and both rendered HTML tests pass.

- [ ] **Step 2: Inspect the rendered page at 1440×1000 and 390×844**

Verify the headline is readable without wrapping into a tall stack, the install action is visible, no content overlaps, the Queue Lab communicates all three states, and the mobile layout has no horizontal overflow.

- [ ] **Step 3: Exercise interaction and accessibility states**

Click Run twice, Reset during a run, use keyboard activation, and emulate reduced motion. Confirm stale timers cannot overwrite the latest run, `aria-live` announces status, focus remains visible, and the final typed result is readable.

- [ ] **Step 4: Review the final diff and generated-source equality**

Run: `cmp -s docs/index.html site/public/landing.html && git diff --check && git status --short`

Expected: source equality succeeds, diff check is clean, and only intentional landing/spec/test files are modified.
