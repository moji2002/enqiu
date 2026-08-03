# Enqiu Queue Lab landing redesign

## Goal

Rebuild the Enqiu landing page so a Node.js or Bun developer understands the
product in seconds, can install it immediately, and can interact with one clear
queue demonstration. The page should feel colorful and playful without looking
juvenile, noisy, or like an operations dashboard.

## Page thesis

Enqiu lets developers call background jobs like typed functions, begin with an
in-memory queue, and switch to Redis without changing the job API.

The first viewport must communicate that thesis with three elements only:

1. A direct headline and one-sentence explanation.
2. An install command and a documentation link.
3. A focused queue lab that moves a single job through its real lifecycle.

## Visual direction

The design is a bright technical workspace rather than a dashboard or arcade.
Its character comes from precision, generous space, and a single expressive
queue animation.

- **Ink** `#13131A`: primary text and dark controls.
- **Canvas** `#F8F7FC`: cool, quiet page background.
- **Paper** `#FFFFFF`: interactive surfaces.
- **Cobalt** `#5267F7`: primary action and queued state.
- **Coral** `#F0715C`: active processing accent.
- **Mint** `#36A77A`: completed state.

Typography uses a characterful rounded display stack for the hero, a neutral
system sans stack for body copy, and the existing mono stack for code and state.
Color is concentrated in the queue lifecycle and small functional accents.

## Layout

The navigation contains the Enqiu wordmark, Docs, GitHub, and one compact install
action. The hero uses an asymmetric two-column composition on desktop and a
single column on mobile.

```text
+---------------------------------------------------------------+
| enqiu.                              Docs  GitHub  Install       |
+---------------------------------------------------------------+
|                                                               |
|  Background jobs,                 +-------------------------+  |
|  called like functions.           |  sendEmail              |  |
|                                    |                         |  |
|  Type-safe queue for Node + Bun.   |  Queued -> Working ->   |  |
|  [ pnpm add enqiu ]  Read docs     |              Complete   |  |
|                                    |                         |  |
|  Zero deps · Memory -> Redis       |  [ Run another job ]    |  |
|                                    +-------------------------+  |
+---------------------------------------------------------------+
|  Define once  ->  Call it  ->  Await a typed result            |
+---------------------------------------------------------------+
|  Focused code examples and capability sections                 |
+---------------------------------------------------------------+
```

The rest of the existing documentation remains available, but its introduction
is reorganized into a short three-step story before the detailed reference. The
page should not repeat the same product facts in multiple cards.

## Signature interaction

The Queue Lab shows one `sendEmail` job, not three parallel lanes. It imports
the compiled Enqiu package in the browser, creates a real memory queue, and
renders the package's `added`, `started`, `progress`, and `succeeded` events.
Pressing the primary control runs this lifecycle:

1. The job enters as `queued` in cobalt.
2. It slides along a single track and becomes `working` in coral.
3. A compact progress line advances.
4. It settles as `complete` in mint and reveals the typed result.

The current event stream, failure toggle, stat grid, explanatory footer, and
multiple simultaneous job cards are removed. A secondary reset/run control is
enough. Motion is interruptible, respects `prefers-reduced-motion`, and never
prevents the interface from reaching its final state. The product explicitly
supports modern browsers through its in-memory driver; Redis remains a
server-runtime option for durable or distributed work.

## React admin

The separate `/admin` route is a React application backed by its own real
in-browser Enqiu memory queue. It exposes live queue statistics, recent jobs,
progress, typed results, worker pause/resume, concurrency, filtering, cleanup,
and enqueue controls. It labels the runtime as local to the current tab so the
non-durable boundary is never ambiguous.

## Content hierarchy

- Headline: **Background jobs, called like functions.**
- Support: **A small, type-safe queue for Node.js and Bun. Start in memory, move
  to Redis, and keep the same job API.**
- Primary action: copy `pnpm add enqiu`.
- Secondary action: read the quick start.
- Proof line: zero runtime dependencies, inferred input and result types,
  memory and Redis drivers.

The queue demonstration uses plain labels and familiar lifecycle language. It
does not expose internal implementation terminology in the hero.

## Responsive and accessible behavior

On narrow screens the text comes first and the Queue Lab follows at full width.
The lifecycle track becomes vertical only when the horizontal states cannot fit
comfortably. Controls remain at least 44 pixels tall, keyboard focus is visible,
status changes are announced politely, contrast meets WCAG AA, and reduced-motion
users see immediate state transitions without decorative movement.

## Verification

- The rendered root contains the new headline, install action, and Queue Lab.
- The queue control reaches queued, working, and completed states.
- Browser-observed Enqiu stats agree with the Queue Lab's completed state.
- `/admin` renders React, reads real `queue.list()` and `queue.stats()` data,
  and its pause, enqueue, resume, cleanup, and concurrency controls work.
- The old multi-lane board, event stream, failure toggle, trust-card grid, and
  playground footer are absent.
- Existing documentation anchors and copy interactions continue to work.
- Layout is visually inspected at desktop and mobile widths.
- Site lint, rendered HTML tests, and build pass.
