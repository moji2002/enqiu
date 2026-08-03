# Enqiu Playground Workbench Design

## Purpose

Replace the misleading queue admin with a complete, playful React workbench
that lets developers operate the real Enqiu memory queue in their browser. The
landing page remains persuasive and concise; the workbench becomes the place
to explore queue behavior in depth.

The interaction model is grounded in the first-party product research captured
in [`docs/research/2026-08-03-enqiu-playground-research.md`](../../research/2026-08-03-enqiu-playground-research.md).

## Product Truth

- This is a playground, not an administration console.
- Every displayed job and state transition comes from the actual Enqiu memory
  driver running in the current browser tab.
- Browser jobs are intentionally non-durable. Reloading or closing the tab
  resets the queue.
- Redis remains a server-runtime capability for durable or distributed work.
- The playground executes curated job handlers. It accepts editable JSON input
  but does not execute arbitrary user-authored JavaScript.

## Information Architecture

### Landing page

- Remove the `Admin` navigation item and all admin terminology.
- Add `Playground` as a primary navigation destination.
- Render the complete landing through React. Copy feedback and queue-preview
  state must use React state and handlers; no imperative DOM event wiring.
- Keep one compact, real queue lifecycle preview in the hero.
- The preview demonstrates enqueue → work → result and leads to the full
  workbench with a clear `Open playground` action.
- Reduce the excessive page length and repeated code blocks. Preserve the
  strongest product explanations: typed handlers, memory-to-Redis progression,
  reliability contract, and installation.

### `/playground`

The dedicated React route is a queue workbench with four conceptual areas:

1. **Job composer** — choose a job recipe, edit validated JSON input, and set
   enqueue options.
2. **Queue canvas** — see waiting, running, delayed, and completed jobs move
   through a compact animated lifecycle.
3. **Queue controls** — pause/resume the worker, change concurrency, clean
   completed jobs, and reset the browser session.
4. **Job inspector** — inspect input, options, attempts, progress, logs, error,
   result, and a timestamped lifecycle timeline.

Desktop uses a purposeful three-column workbench: composer, queue, inspector.
Tablet reduces the inspector to a slide-over panel. Mobile uses a stacked flow
with a sticky mode switch between Compose, Queue, and Inspect so no desktop
panel is crushed into a narrow viewport.

## Job Recipes

The workbench ships with three curated handlers that exercise different Enqiu
features:

- `sendEmail` — short two-step progress flow with structured logs.
- `resizeImage` — longer multi-step job suited to concurrency and cancellation.
- `syncAccount` — optional deterministic failure on the first attempt to
  demonstrate retry and redrive behavior.

Each recipe includes a concise description, default JSON input, typical result,
and the queue capabilities it demonstrates. Recipe input can be edited as JSON
and must be validated before enqueueing. Invalid JSON stays in the composer and
produces an actionable inline error without creating a queue job.

## Enqueue Options

The composer exposes only options that are useful in an in-tab playground:

- priority: low, normal, or high;
- delay: none, 2 seconds, or 5 seconds;
- retry attempts: 1, 2, or 3;
- deterministic failure toggle for compatible recipes;
- optional custom job ID.

Advanced options additionally expose timeout, expiry, and deduplication key.
Scenario shortcuts provide `Queue three`, `Fail once`, and `Schedule +5s` by
configuring and submitting real Enqiu jobs through the same composer path.

Advanced options use progressive disclosure. Defaults remain visible and the
primary `Enqueue job` action remains obvious.

## Queue Controls and States

- Worker pause/resume is always visible and reflects real worker state.
- Concurrency supports 1, 2, or 4 and calls the real queue API.
- A selected queued or running job can be cancelled.
- Failed jobs can be redriven through the real queue API.
- Completed, failed, cancelled, and expired jobs can be cleaned up.
- Reset closes the existing worker and creates a fresh in-memory queue only
  after an explicit confirmation.
- Filters cover All, Active, Scheduled, Succeeded, Failed, and Stopped, with a
  job-name search, active-result count, and one-click filter reset.

The queue must include honest states for empty, paused, invalid input, running,
failure, cancellation, and completion. There are no fabricated production
metrics, teams, users, or distributed-worker claims.

The compact summary shows queued, running, succeeded, and failed counts plus
`running / concurrency`. The full seven-state counts remain available in the
filter row. Rows show job name, short ID, state, progress, attempt, relative
time, and priority or delay only when relevant.

## Job Inspector

The inspector is contextual and never behaves like a generic properties panel.
It selects a newly enqueued job automatically while preserving manual selection
during unrelated live updates.

- **Overview** shows identity, lifecycle, timing, options, attempt count, and
  the state-appropriate action.
- **Input** shows formatted JSON with Copy and `Edit as new job`.
- **Logs** shows timestamp, level, message, and structured fields.
- **Result** shows formatted output for success; it becomes **Error** on failure
  and opens automatically with error name, message, stack, and retry history.

Cancel is available only for queued, scheduled, or running work. Redrive is
available only for failed, cancelled, or expired jobs. `Run again` copies the
input into the composer so the new invocation is visible and editable.

## Visual Direction

The workbench should feel like a precise developer instrument with playful
physical feedback, not a generic SaaS dashboard.

- Preserve Enqiu's editorial black typography and periwinkle signature color.
- Use a warm near-white canvas, ink surfaces, and a limited set of semantic
  accents: periwinkle for queued, coral for running or failure, and mint for
  success.
- Avoid gradients, glass cards, oversized empty metric tiles, fake terminal
  chrome, and ornamental blobs.
- Use thin rules and compact type scales to create density without clutter.
- Let queue mechanics drive the signature visual: jobs appear as small labeled
  tokens that occupy waiting slots, cross a worker gate, and settle into
  history.
- Use one display face for strong section labels and a monospace face for job
  names, IDs, JSON, logs, and timing.

### Implementation design contract

**Direction: Queue bench.** The surface should resemble a compact physical test
bench where job tickets move through a visible worker gate. It rejects the
current generic sidebar/dashboard shell, a terminal-only developer tool, and a
large node-graph canvas: all three weaken the compose → run → inspect loop.

**Palette**

- Canvas — `#f5f4fa`
- Paper — `#fffefa`
- Ink — `#171720`
- Queue periwinkle — `#5968f6`
- Worker coral — `#ef705d`
- Success mint — `#31a97a`

**Type**

- Display: `Avenir Next`, `Segoe UI`, Helvetica, Arial, sans-serif, using heavy
  weights only for the product name and workbench title.
- Body/control: Inter, `Segoe UI`, system sans-serif.
- Data: `SFMono-Regular`, `Cascadia Code`, Consolas, monospace.

**Layout**

```text
┌ Enqiu / Playground ───── worker 0/2 · pause · reset ┐
├───────────────┬──────────────────────┬───────────────┤
│ COMPOSE       │ LIVE QUEUE           │ JOB INSPECTOR │
│ recipe        │ filters + search     │ status/actions│
│ JSON input    │ waiting → gate → done│ timeline      │
│ options       │ job rows             │ evidence tabs │
│ [Enqueue job] │                      │               │
└───────────────┴──────────────────────┴───────────────┘
```

**Signature:** the live queue is organized around a worker gate whose open,
closed, and occupied slots are driven by real worker state and concurrency.
Small job tickets carry the Enqiu three-square mark, name, and state through the
gate. The rest of the interface stays visually quiet so this mechanism remains
memorable.

## Motion

Motion explains queue state rather than decorating the page.

- Enqueue: a job token enters the waiting lane with a short spring.
- Start: the token crosses the worker gate and the progress track begins.
- Progress: the token advances in discrete handler steps.
- Complete: the token settles into history with a restrained success mark.
- Failure: the token stops and exposes retry/redrive without a dramatic shake.
- Pause: the gate visibly closes while queued tokens remain stable.
- Concurrency: worker slots expand or contract without rearranging history.

All motion must be interruptible, avoid layout thrash, and collapse to immediate
state changes under `prefers-reduced-motion`.

## React Architecture

- Keep the Vite React entry but rename the source surface from `admin` to
  `playground` and build to `site/public/playground/`.
- `createPlaygroundQueue()` owns the real Enqiu definitions and returns a fresh
  queue instance.
- `usePlaygroundQueue()` owns subscriptions, queue refreshes, worker controls,
  and teardown. It exposes stable actions and derived view state.
- `JobComposer`, `QueueCanvas`, `QueueToolbar`, and `JobInspector` remain
  separate components with narrow props.
- Queue event subscriptions trigger a single batched refresh rather than
  duplicating queue state inside components.
- Expensive JSON formatting and filtered job lists are derived with memoization;
  transient progress animation data does not cause unrelated rerenders.

## Landing Integration

The landing is a small React entry separate from the React workbench bundle.
Its queue-preview hook imports the compiled Enqiu browser ESM artifact and maps
real lifecycle events into React state. The primary action is `Open playground`;
the one-job run remains immediate proof that the library works in browsers.
The HTML entry retains a `noscript` fallback, but no interactive behavior uses
`querySelector`, `addEventListener`, or standalone DOM scripts.

## Routes and Build

- `/playground` rewrites to `/playground/index.html` on Vercel.
- `/admin` is removed rather than redirected so the product does not preserve
  the wrong concept.
- The Cloudflare worker serves `/playground` and `/playground/` from the same
  generated asset.
- The site build compiles the root package, syncs the browser ESM files, then
  builds the React landing and React workbench before deployment.

## Error Handling

- Invalid JSON and invalid recipe input show specific inline messages.
- Queue action failures use a single workbench alert region and retain user
  input.
- Job handler failures appear in the selected job timeline and inspector.
- Reset or teardown cancels active work safely and closes the worker.
- Unexpected initialization failures replace the workbench with a recoverable
  `Reload playground` state.
- The composer payload is mirrored to session storage so an unexpected reload
  can restore user input without persisting queue state.

## Accessibility

- All controls are keyboard reachable and have visible focus treatment.
- Tabs and segmented controls use their correct ARIA roles and selected states.
- Queue state changes are announced through a restrained polite live region.
- Status is never communicated by color alone.
- Inspector data uses semantic headings, definition lists, lists, and code
  blocks.
- Touch targets remain at least 44px on mobile.

## Verification

- Package typecheck, unit tests, and build pass.
- Site TypeScript, lint, build, and rendered artifact tests pass.
- Browser automation verifies enqueue, pause, delayed jobs, concurrency,
  cancellation, failure, redrive, cleanup, reset, and inspector contents.
- Desktop, tablet, and mobile screenshots are visually reviewed.
- Both surfaces have no console errors or horizontal overflow.
- Production is checked through the custom domain after deployment.

## npm Release

The current registry release does not contain browser metadata. After the
workbench and package artifacts pass verification:

- bump the package from `0.1.2` to `0.1.3`;
- retain the browser export and browser documentation;
- verify the packed tarball contains the compiled ESM and declarations;
- publish only with explicit user authorization for the registry mutation;
- verify `npm view enqiu` exposes the new version, description, and browser
  export.

## Out of Scope

- Connecting the browser playground to Redis.
- Persisting jobs across page reloads.
- Executing arbitrary user-authored JavaScript.
- Authentication, teams, permissions, or production queue administration.
- Fabricated monitoring data or remote worker management.
