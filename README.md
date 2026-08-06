# Enqiu

[![npm](https://img.shields.io/npm/v/enqiu/beta?style=flat-square&label=beta)](https://www.npmjs.com/package/enqiu)
[![status](https://img.shields.io/badge/status-beta-2563eb?style=flat-square)](#status-beta)
[![built on](https://img.shields.io/badge/built_on-BullMQ-b91c1c?style=flat-square)](https://bullmq.io)
[![license](https://img.shields.io/npm/l/enqiu?style=flat-square)](LICENSE)

A type-safe job API on top of [BullMQ](https://bullmq.io). Define each job once
with a schema, then call it like a function — the name, input and result types
are inferred, so there is no separate registry and no string-keyed dispatch.

BullMQ owns storage, scheduling and execution. Enqiu owns the developer
experience.

[npm](https://www.npmjs.com/package/enqiu) ·
[Issues](https://github.com/moji2002/enqiu/issues)

## Status: beta

> [!NOTE]
> **Enqiu is beta software.** The shape of the API is settled and the hard
> parts — storage, retries, scheduling and crash recovery — are BullMQ's,
> which is mature and widely deployed.
>
> What is new is the layer in between. Expect edge-case bugs there, and pin an
> exact version: it is published under the `beta` dist-tag, so a plain
> `npm install enqiu` will not install it.
>
> One caveat worth knowing: `queue.on("added")` can miss a job submitted in the
> same breath as the very first subscription, because BullMQ's event stream
> begins reading from the present. Later events, and everything after the
> stream is live, are delivered normally.

```bash
npm install enqiu@beta bullmq ioredis
```

`bullmq` and `ioredis` are peer dependencies — Enqiu does not pick versions or
open connections for you.

## Quick start

```ts
import { enqiu, job } from "enqiu";
import { z } from "zod";

const jobs = enqiu(
  {
    sendEmail: job({
      input: z.object({ to: z.string(), subject: z.string() }),
      retry: { attempts: 3, backoff: { type: "exponential", delay: 500 } },
      timeout: 30_000,
      run: async (input, { log }) => {
        log.info("sending", { to: input.to });
        return { delivered: true, subject: input.subject };
      },
    }),
  },
  {
    name: "notifications",
    connection: { host: "localhost", port: 6379 },
    worker: { concurrency: 10 },
  },
);

const handle = await jobs.sendEmail({ to: "a@b.c", subject: "Welcome" });
const result = await handle.result;   // { delivered: boolean; subject: string }
```

`await jobs.sendEmail(input)` resolves once BullMQ accepts the job and returns a
handle. It does not wait for the handler. Await `handle.result` only when the
caller needs the result.

A plain handler works too, with input and output still inferred:

```ts
const jobs = enqiu(
  { resizeImage: async (input: { key: string; width: number }) => input },
  { connection },
);
```

## What Enqiu adds

- **Inferred types end to end.** Job names come from the object keys; input and
  result types come from the schema and handler. No generics to write.
- **Standard Schema validation at the boundary.** Zod, Valibot, ArkType or
  anything else implementing the spec. Invalid input is rejected before a job
  is queued.
- **Per-attempt `timeout`,** with an `AbortSignal` handed to the handler. BullMQ
  has no job timeout; Enqiu enforces this itself.
- **`expiresIn`,** which fails a job that waited too long without running it.
  Also enforced by Enqiu.
- **A serialization guard** that rejects functions, symbols, cycles and sparse
  arrays with the exact path, instead of failing later inside the queue.

## What BullMQ provides

Retries and backoff, priorities, delays, cron schedules, deduplication, bulk
submission, progress, logs, events and cleanup are BullMQ's, surfaced through
Enqiu's API.

## Compatibility notes

Enqiu deliberately does not paper over gaps in BullMQ's open-source tier:

| Not available | Why |
| --- | --- |
| Per-key concurrency (`concurrency: { by }`) | BullMQ groups are a **BullMQ Pro** feature. |
| Per-key rate limiting (`throttle: { by }`) | The OSS limiter is one global `{ max, duration }` per worker. |
| Debounce | No open-source equivalent. |
| In-browser queues | BullMQ requires Redis and Node. |

If you need any of those, use BullMQ Pro directly, or pin Enqiu 0.2.x, which
shipped first-party memory and Redis drivers that implemented them.

## Testing

```bash
docker run -d -p 6379:6379 redis:7-alpine
ENQIU_TEST_REDIS_URL=redis://localhost:6379 pnpm run check
ENQIU_TEST_REDIS_URL=redis://localhost:6379 pnpm run scenarios
```

Almost every test needs a real Redis, because almost every code path goes
through BullMQ. Without `ENQIU_TEST_REDIS_URL` only the serialization tests
run, and coverage thresholds are disabled rather than gating on a number the
run never verified.

Five runnable, self-asserting scenarios live in
[`examples/scenarios/`](examples/scenarios): webhook ingestion, notification
campaigns, report progress, a transcoding pool, and failure triage. The
reasoning behind the workload choices is in
[`docs/use-case-research.md`](docs/use-case-research.md).

## License

MIT
