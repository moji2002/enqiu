# What people actually use job queues for

Research behind `examples/scenarios/`. The goal was to pick five scenarios from
what the ecosystem documents rather than from intuition, and to check that each
one exercises a feature Enqiu actually ships.

Researched 2026-08-06.

## How to read the evidence grades

Most writing about queues is vendor documentation or blog posts, not research.
Grades used below:

| Grade | Means |
| --- | --- |
| **Normative** | A standard or spec. Binding, not an opinion. |
| **Vendor-documented** | A library's own list of what its users do. Real signal about demand, but it is marketing and has an interest in a long list. |
| **Convention** | Widely practised, described consistently across independent sources, no measurement offered. |
| **Heuristic** | One author's recommendation. Treat as a hypothesis. |

There is **no empirical evidence** cited here, because none was found. Nobody
appears to have published a survey of what background jobs are actually used
for, or measurements of queue-pattern outcomes. Claims like "queues give you
retries, prioritisation, scheduling and observability almost for free" are
vendor framing, not findings. Nothing below is graded higher than
vendor-documented, and that is the honest ceiling on this topic.

## Findings

### 1. The canonical workload list is consistent across sources

BullMQ's own use-case page enumerates eight: e-commerce order processing, video
and media processing, email and notification campaigns, webhook processing, data
pipelines and ETL, AI/ML orchestration, document and report generation, and IoT
sensor ingestion. Independent write-ups repeat a near-identical set — email,
image resizing, third-party API calls, report generation, push notifications.

**Grade: vendor-documented**, corroborated by convention. The consistency across
unrelated authors is the useful part; the specific ordering is not.

### 2. Rate limiting is two separate mechanisms, not one

Production systems layer a *request-rate* limiter (calls per window) with a
*concurrency* limiter (simultaneous in-flight calls). Stripe is cited as using
token buckets for overall request rate plus a distinct limiter for concurrent
requests. Token bucket is favoured because it permits short bursts while
holding the long-run rate.

**Grade: convention.** Described the same way by multiple independent sources.
The Stripe detail is second-hand and uncited — treat as illustrative.

This maps directly onto Enqiu having `throttle` (token bucket, with `burst`) and
`concurrency` (keyed, counts what is running) as *independent* policies. That
they are separate is not an accident of the API; it reflects the two-mechanism
model. Scenario 2 exercises both at once.

### 3. Multi-tenant fairness means per-key limiting, not global

In multi-tenant systems each tenant needs its own bucket, so one noisy customer
cannot consume a shared budget. The recurring shape is "per-tenant token bucket
plus fair queueing."

**Grade: convention.**

This is what `by: (input) => input.tenantId` is for on both `concurrency` and
`throttle`. Without a keying function these policies would only express a global
cap, which the sources agree is the wrong shape for multi-tenant work.

### 4. Webhook processing is defined by deduplication

Every source that mentions webhooks pairs them with deduplication and
dead-letter handling — because at-least-once delivery from providers means the
same event arrives more than once, and the consumer is responsible for
idempotency.

**Grade: convention**, and it follows from provider contracts rather than taste:
Stripe, GitHub and others document at-least-once delivery, so duplicate handling
is a requirement, not a nicety.

Enqiu's `idempotencyKey` + `idempotencyTtl` is the direct fit. Scenario 1 shows a
redelivered event returning the *same* handle rather than doing the work twice.

### 5. The browser case is real but different, and is where Enqiu diverges

Local-first architecture puts the source of truth in a local database with
background sync. The browser platform offers `requestIdleCallback` (Background
Tasks API) for cooperative scheduling and Background Sync via service workers
for offline replay. One source distinguishes a **foreground queue** for
destructive or high-risk actions from **Background Sync** for low-risk,
high-frequency edits.

**Grade: normative** for the platform APIs (MDN/W3C); **heuristic** for the
foreground-vs-background-sync split, which is one author's framing.

This matters because it bounds what Enqiu's memory driver is for. An in-tab
queue dies with the tab, so it is *not* a Background Sync substitute and must not
be sold as one. It fits the foreground-queue role: sequencing, debouncing and
retrying work while the user is present. Scenario 5 stays inside that boundary.

Debounced autosave is the recurring concrete example. **Grade: convention** —
widely practised, but the "correct" debounce interval is folklore. No source
offers a measured value, so scenario 5 picks one and says it is arbitrary.

## Scenario selection

Ten scenarios in `examples/scenarios/`, covering the eight documented workloads
plus two operational ones, and collectively exercising most of the API. Each
script asserts its own outcome, so `pnpm run scenarios` exiting 0 is a real
signal rather than "it printed something".

| # | Scenario | From finding | Exercises |
| --- | --- | --- | --- |
| 1 | Webhook ingestion | 4 | `idempotencyKey`, exponential backoff with jitter, `when` predicate, failed terminal state |
| 2 | Multi-tenant API sync | 2, 3 | keyed `concurrency` and `throttle` with `burst`, both keyed by tenant |
| 3 | Notification campaign | 1 | `bulk`, priority tiers, `delay`, `cancel`, cron `schedule` lifecycle |
| 4 | Report generation | 1 | `reportProgress`, structured `log`, `timeout`, `signal` abort, event subscription |
| 5 | Local-first autosave | 5 | trailing `debounce` keyed per document, `expiresIn`, in-tab memory driver |
| 6 | Order processing | 1 | `concurrency: 1` keyed by order as a per-entity lock, idempotent checkout |
| 7 | Media transcoding | 1 | bounded worker pool, priority across a backlog, `queue.setConcurrency` at runtime |
| 8 | Inference orchestration | 1, 2 | GPU slots keyed by model, deadlines, queue depth as backpressure, `queue.pause` |
| 9 | Sensor ingestion | 1 | volume via `bulk`, sink `throttle`, `historyLimit`, `list` pagination, `cleanup` |
| 10 | Failure triage & shutdown | 1 | query by terminal status, `redrive`, telemetry, draining vs abrupt `close` |

Scenarios 1 and 2 run on both drivers when `ENQIU_TEST_REDIS_URL` is set, which
is the sharpest test of the library's central claim: that the same job API works
on memory and Redis without changes.

### What running them found

Writing scenarios against a real Redis surfaced two defects that the unit suite
had not:

1. **`worker.onIdle()` was effectively a no-op on Redis.** It waited only on
   locally in-flight work, so called right after submitting — before the poll
   loop had claimed anything — it returned immediately with a full backlog. The
   in-memory driver waited on queued work too. Fixed, with a regression test
   that fails against the old behaviour.
2. **`when` retry predicates are silently dropped by the Redis driver**, because
   a function cannot cross the process boundary. This is inherent rather than a
   bug, but it was undocumented; scenario 1 now states it at the point of use.

Two apparent failures turned out to be faults in the scenarios themselves — a
read-modify-write race in the concurrency counters (`now - 1` instead of
decrementing the current value) that misreported a peak of 3 against a limit of
2. Worth recording because the instrument, not the library, is the usual
suspect when a concurrency assertion fails by one.

## What this research did not settle

- **No sizing guidance.** Nothing found gives defensible defaults for
  concurrency, retry counts or backoff. Enqiu's defaults are asserted, not
  derived, and the scenarios pick values to make behaviour visible in a few
  seconds — they are not recommendations.
- **Dead-letter queues.** Named repeatedly as a webhook requirement. Enqiu has
  no DLQ; failed jobs stay queryable via `queue.list({ status: "failed" })` and
  `queue.redrive(id)`. Whether that is sufficient is untested.
- **Job dependencies / flows.** BullMQ lists ETL and multi-step workflows as
  relying on job dependencies. Enqiu has no equivalent, so no scenario covers
  it. That is a genuine feature gap, not an oversight in the scenarios.

## Sources

- [BullMQ — Use Cases](https://bullmq.io/use-cases/) (vendor)
- [Background Job Processing in Node.js: BullMQ, Queues, and Worker Patterns (2026)](https://dev.to/young_gao/background-job-processing-in-nodejs-bullmq-queues-and-worker-patterns-31d4)
- [Best Practices for Handling API Rate Limits and Retries Across Multiple Third-Party APIs — Truto](https://truto.one/blog/best-practices-for-handling-api-rate-limits-and-retries-across-multiple-third-party-apis/)
- [Rate Limiting Multi-Tenant Environments with the Token Bucket Algorithm — Will Dady](https://willdady.com/rate-limiting-multi-tenant-environments-with-the-token-bucket-algorithm-on-aws)
- [Background Tasks API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Tasks_API) (normative)
- [Local-first software — Wikipedia](https://en.wikipedia.org/wiki/Local-first_software)
- [Offline Support in Web Apps: Foreground Queue vs. Background Sync — Tomasz Gil](https://blog.tomaszgil.me/offline-support-in-web-apps-foreground-queue-vs-background-sync)
- [Why Local-First Software Is the Future and its Limitations — RxDB](https://rxdb.info/articles/local-first-future.html)
- [Implementing Efficient AutoSave with JavaScript Debounce Techniques](https://kannanravi.medium.com/implementing-efficient-autosave-with-javascript-debounce-techniques-463704595a7a)
