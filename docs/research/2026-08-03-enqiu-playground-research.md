# Enqiu Playground Research

Date: 2026-08-03
Scope: first-party documentation and official source repositories only.

## Recommendation

Build `/playground` as a real queue workbench, not an admin dashboard. The
default screen should answer three questions in one glance:

1. What job am I about to enqueue?
2. What is happening in the queue right now?
3. What happened inside the selected job?

The best-fit structure is a composer, live run list, and contextual inspector.
Queue controls belong in a compact toolbar; destructive or state-specific job
actions belong in the inspector. The landing page should show a small live
preview and link to this complete workbench instead of compressing it into the
hero.

## What the strongest products establish

| Product | First-party pattern | Concrete Enqiu lesson |
| --- | --- | --- |
| Inngest Dev Server | A function can be invoked from its Functions view with a JSON payload; the resulting run appears immediately in Runs, where payload, output, timeline, rerun, and cancel are available. The UI can also send arbitrary test events. ([local development](https://www.inngest.com/docs/local-development), [Express quick start](https://www.inngest.com/docs/getting-started/express-quick-start)) | Put template selection, editable JSON, and **Enqueue job** in one surface. Select the new job automatically so the action and its result remain connected. |
| Inngest Traces | Run and step details separate timing from Input, Output, Error details, Headers, and Metadata. Retry attempts are individual timeline spans with attempt badges, and the error tab becomes the default on failure. ([traces](https://www.inngest.com/docs/platform/monitor/traces)) | Give the selected job a compact lifecycle timeline and tabs for Overview, Input, Logs, and Result/Error. On failure, open Error automatically and keep earlier attempts visible. |
| Trigger.dev | A run has a precise lifecycle and one or more attempts. The official API/dashboard supports cancellation and replay, including replay with the same or a changed payload; live subscriptions expose status changes in real time. ([runs](https://trigger.dev/docs/runs)) | Keep status language exact and animate real transitions only. Label recovery **Redrive**, show the next attempt clearly, and allow users to copy the failed input back into the composer for editing. |
| Trigger.dev Queues | Queue state includes running, queued, paused, and effective/base/override concurrency. Pausing prevents new runs from starting while active runs continue. Pause, resume, and concurrency override are first-class operations. ([concurrency and queues](https://trigger.dev/docs/queue-concurrency)) | Show worker state and `running / limit` together. Pause/resume must explain that active jobs finish. Make concurrency a small 1/2/4 segmented control or stepper, not a settings form. |
| Temporal Web UI | The list is filterable by status, identity, type, and time. A selected execution exposes input/results, metadata, pending work, relationships, workers, and multiple history representations: Timeline, All, Compact, and JSON. Actions include cancel, reset, terminate, and starting a new execution pre-filled from the current one. ([Temporal Web UI](https://docs.temporal.io/web-ui)) | Use a master-detail model: scan jobs first, then progressively disclose detail. Preserve a raw JSON view, but make the human timeline the default. “Run again” should pre-fill the composer rather than hiding the new invocation. |
| Bull Board / BullMQ | Bull Board is deliberately a visualization layer over the actual queue and exposes retry/clean actions; adapters can be read-only and can redact formatted job data and return values. BullMQ defines pause as allowing active work to finish and limits manual retry to valid terminal states. ([Bull Board README](https://github.com/felixmosh/bull-board/blob/master/README.md), [pausing queues](https://docs.bullmq.io/guide/workers/pausing-queues), [retrying jobs](https://docs.bullmq.io/guide/jobs/retrying-job)) | Never simulate state independently of Enqiu. Disable or hide actions when invalid. Treat input/output as potentially sensitive even in a demo and avoid examples containing secrets. |
| Cloudflare Workers Playground | The playground needs no setup or authentication, starts with working example code, updates the preview as code changes, provides raw HTTP testing, pretty error pages, a lightweight log viewer, share links, and a path to deploy. ([Playground](https://developers.cloudflare.com/workers/playground/)) | Start with a valid, runnable example rather than an empty dashboard. Keep the main loop immediate: edit, run, observe, change. Provide Reset and Copy input; sharing can wait until the core loop is flawless. |

## Proposed interaction model

### 1. Compose and enqueue

- Start with a working job template selected and valid JSON already loaded.
- Offer several behaviorally distinct templates, not cosmetic examples:
  `sendEmail` (normal progress), `resizeImage` (longer progress), and
  `syncAccount` (retry/failure path).
- Keep common controls visible: job, payload, priority, delay, and an **Enqueue
  job** button. Put retry count, timeout, expiry, custom ID, and deduplication key
  under **Advanced options**.
- Validate JSON before submission, keep the invalid text in place, point to the
  exact line/field, and never clear the editor after an error.
- On acceptance, insert the real job at the top of the live list, select it, and
  briefly identify its Enqiu job ID. Do not use a detached success toast as the
  only feedback.
- Add explicit scenario shortcuts such as **Queue three**, **Fail once**, and
  **Schedule +5s**. They should only configure and submit real Enqiu jobs.

This directly maps to Enqiu's supported submit options—delay, priority, retry,
timeout, expiry, ID, and key—and its typed job callables
([queue API](../../src/api.ts)).

### 2. Live queue and lifecycle

- Use Enqiu's exact states: queued, scheduled, running, succeeded, failed,
  cancelled, and expired ([memory state model](../../src/memory.ts)).
- The top summary should be compact: queued, running, succeeded, failed, plus
  worker state and concurrency. The full seven-state counts can appear in the
  filter row.
- Each row needs job name, short ID, state, progress, attempt, relative time,
  and priority/delay only when relevant. Avoid columns that are mostly empty.
- Use a single restrained motion grammar driven by queue events:
  - queued/scheduled: a slow waiting pulse;
  - running: one moving progress treatment;
  - success/failure/cancel: a brief arrival transition, then stillness;
  - list movement: position animation without replaying every row entrance.
- Preserve the selected row during live updates. New jobs should not steal
  selection unless the user just created them.
- Filters should include All, Active, Scheduled, Succeeded, Failed, and Stopped
  (cancelled + expired), plus a job-name search. Show an active-result count and
  a one-click clear filter.

### 3. Queue controls

- Place **Pause worker / Resume worker**, concurrency, and **Reset playground**
  in the workbench header.
- While paused, show a plain-language banner: “Paused — queued jobs will wait;
  1 running job will finish.” This reflects the behavior documented by
  Trigger.dev and BullMQ, and avoids implying that pause cancels active work.
- Make concurrency changes visible immediately as `running / limit`; explain
  why extra jobs remain queued when the limit is saturated.
- Put cleanup behind a menu with explicit scope, such as **Clear completed** or
  **Clear all terminal jobs**. Never use an ambiguous **Clean** button.

### 4. Selected-job inspector

Default content:

- identity: name, short/full ID, state, created time, duration;
- attempt: current attempt and configured retries;
- lifecycle: created → scheduled/queued → started → progress/retry → terminal;
- progress: structured value plus a friendly percentage when the data permits;
- context actions: Cancel while queued/scheduled/running; Redrive only for
  failed/cancelled/expired; Copy input and Run again for terminal jobs.

Tabs:

1. **Overview** — lifecycle, timing, options, and action explanation.
2. **Input** — formatted JSON with copy and “Edit as new job.”
3. **Logs** — timestamp, level, message, and expandable structured fields;
   follow-tail only while the user is already at the bottom.
4. **Result** — formatted output when successful; **Error** with name, message,
   stack, and retry history when failed. Automatically select Error on failure.

Enqiu exposes real progress, structured logs, result/error, attempts, timing,
cancel, and `queue.redrive()`; redrive is valid only for failed, cancelled, or
expired jobs in the memory driver ([public API](../../src/api.ts), [redrive
implementation](../../src/memory.ts)).

## Empty, loading, and error states

- **First visit:** render the whole workbench immediately with a seeded template
  and an empty list message that contains one action: **Enqueue this example**.
  Cloudflare's default runnable example is a better playground model than a
  blank analytics dashboard.
- **No filtered results:** retain filters and composer; say which filter has no
  matches and offer **Clear filter**.
- **Invalid payload:** show an inline editor error; never create a fake failed
  queue job.
- **Handler failure:** keep the job and its evidence visible, open Error, and
  offer contextual Redrive and Edit as new job.
- **No worker / paused worker:** distinguish infrastructure state from job
  failure. Temporal explicitly surfaces an error when no workers poll a task
  queue ([Temporal Web UI](https://docs.temporal.io/web-ui)); Enqiu should show
  an equally direct paused-worker message.
- **Unexpected playground crash:** preserve the last payload in session storage,
  show a compact recovery panel, and offer Reload / Reset. Cloudflare's
  playground similarly provides dedicated error pages rather than silently
  losing the working context.

## Responsive layout

The product docs above establish the information hierarchy but do not prescribe
an Enqiu mobile layout. The following is a synthesis, not a claim about their
exact implementations:

- **Desktop (`>= 1100px`):** composer at left, live jobs in the center, selected
  job inspector at right. The list gets the most width; the inspector can be
  resized or collapsed.
- **Tablet (`700–1099px`):** composer becomes a collapsible top section; jobs and
  inspector use a two-pane master-detail layout.
- **Mobile (`< 700px`):** one task at a time. Show a compact queue header, then
  tabs for **Compose** and **Jobs**. Selecting a job opens a full-screen detail
  route/sheet with a clear Back control. Keep Enqueue sticky only while Compose
  is active; never pin multiple toolbars over the content.
- Preserve payload and selection when moving between breakpoints. Tables must
  become stacked job rows, not horizontally scrolling desktop tables.
- Respect `prefers-reduced-motion`: status remains legible without animation,
  and no queue state may be communicated by color or motion alone.

Cloudflare's official playground is currently limited to Firefox and Chrome on
desktop ([browser support](https://developers.cloudflare.com/workers/playground/));
that is a constraint to improve on, not copy. Enqiu's browser claim should be
validated on mobile Safari as well as Chromium before release.

## Release note for browser support

The local package is currently `0.1.2`, while browser support is present in the
working package metadata. npm requires every published name/version pair to be
unique, and a version that was published and later unpublished cannot be reused
([`npm publish`](https://docs.npmjs.com/cli/publish/)).

For a `0.1.3` release:

1. Confirm `enqiu@0.1.3` has never been published.
2. Run the full package checks and inspect `npm publish --dry-run`; npm explicitly
   recommends reviewing package contents and testing the package before publish
   ([publishing public packages](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)).
3. Bump package metadata to `0.1.3`. Be aware that `npm version` creates a Git
   commit and tag by default; `npm --no-git-tag-version version 0.1.3` disables
   that automatic Git mutation ([`npm version`](https://docs.npmjs.com/cli/v11/commands/npm-version/)).
4. Publish from an authorized owner account. Direct publish requires account 2FA
   or a granular access token configured to bypass 2FA; trusted publishing is
   the safer CI path ([npm publishing requirements](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)).
5. Verify the registry/package page, then install `enqiu@0.1.3` into a clean
   browser consumer and test the exported memory queue—not merely the repository
   build.

npm describes backward-compatible bug fixes as patch releases and
backward-compatible features as minor releases
([semantic versioning](https://docs.npmjs.com/about-semantic-versioning/)).
Therefore `0.1.3` is defensible if this release is treated as correcting missing
browser packaging for an already-supported memory runtime. If browser support is
being introduced as a new public capability, npm's guidance points to `0.2.0`.

## Scope discipline

Ship the complete queue loop before adding analytics, multi-queue navigation,
authentication, share links, or production Redis connectivity. A convincing
playground is real execution plus excellent observability and recovery—not a
miniature operations platform.
