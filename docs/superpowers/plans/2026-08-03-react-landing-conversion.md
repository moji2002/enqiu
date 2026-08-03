# React Landing Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the complete Enqiu landing experience from static DOM event wiring to a typed React application while preserving its approved visual design and real in-browser queue proof.

**Architecture:** `docs/index.html` remains the Vite HTML entry and no-JavaScript fallback. `docs/landing.tsx` owns the rendered interface, copy feedback, and queue preview; `docs/use-landing-queue.ts` owns a real Enqiu memory queue and lifecycle subscriptions. A dedicated Vite configuration emits stable root landing assets alongside the separate `/playground` bundle.

**Tech Stack:** React 19, TypeScript, Vite 8, Enqiu memory driver, CSS.

## Global Constraints

- The rendered landing must be React-owned.
- No `querySelector` or `addEventListener` interaction wiring may remain.
- The preview must use actual Enqiu handlers and lifecycle events.
- Preserve the current landing composition, responsive behavior, and reduced-motion treatment.
- Do not deploy, commit, push, or publish without explicit authorization.

---

### Task 1: Lock the React landing artifact contract

**Files:**
- Modify: `site/tests/rendered-html.test.mjs`
- Create: `site/landing.vite.config.ts`

**Interfaces:**
- Consumes: `docs/index.html`, `docs/landing.tsx`, `docs/use-landing-queue.ts`
- Produces: `site/public/index.html`, `landing.js`, and `landing.css`

- [ ] Assert the landing source calls `createRoot`, the queue hook imports `enqiu`, and generated HTML references `/landing.js`.
- [ ] Assert interactive landing sources contain no `querySelector` or `addEventListener` wiring.
- [ ] Update the root asset mock and worker contract from `/landing.html` to `/index.html`.

### Task 2: Build the React landing and real queue-preview hook

**Files:**
- Create: `docs/landing.tsx`
- Create: `docs/use-landing-queue.ts`
- Modify: `docs/index.html`
- Delete: `docs/queue-lab.js`

**Interfaces:**
- Produces: `CopyCommand`, `QueuePreview`, `LandingApp`, and `useLandingQueue()`
- Consumes: the public `enqiu` API and `JobHandle`

- [ ] Move all rendered landing markup into `LandingApp`, with `className`, React state, and typed click handlers.
- [ ] Implement copy success/failure feedback as component state.
- [ ] Implement queued, running, progress, success, failure, reset, and teardown through a real in-memory queue hook.
- [ ] Keep the current static body only inside `noscript`; mount the React application into `#root`.

### Task 3: Integrate, verify, and inspect

**Files:**
- Modify: `site/package.json`
- Modify: `site/scripts/sync-landing.mjs`
- Modify: `.gitignore`
- Modify: `site/worker/index.ts`
- Modify: `vercel.json`

**Interfaces:**
- Produces: reproducible React landing and playground deployment artifacts

- [ ] Build the root package, sync browser ESM and OG assets, build the React landing, then build the React playground.
- [ ] Run site lint, TypeScript, build, route tests, and the root package check.
- [ ] Browser-test copy feedback, real queue transitions, desktop/tablet/mobile overflow, reduced motion, and console errors.
- [ ] Run `vercel build --yes --prod` and verify both React bundles exist with no admin artifact.
