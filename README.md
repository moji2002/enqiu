# Enqiu

A small, type-safe job queue for Node.js and Bun. Start in memory, move to
Redis without changing your job API.

```bash
pnpm add enqiu
```

Enqiu has no runtime dependencies. Redis, schema, Hono, and telemetry packages
remain your choice.

## Quick start

Define each job once, then call it like a function. The name, input, and result
types are inferred.

```ts
import { enqiu, job } from "enqiu";
import { z } from "zod";

const jobs = enqiu({
  sendEmail: job({
    input: z.object({
      to: z.email(),
      subject: z.string(),
    }),
    run: async (email, { signal, log }) => {
      log.info("Sending email", { to: email.to });

      const response = await fetch("https://example.com/email", {
        method: "POST",
        body: JSON.stringify(email),
        signal,
      });

      return { delivered: response.ok };
    },
  }),
});

const delivery = await jobs.sendEmail({
  to: "hello@example.com",
  subject: "Welcome",
});

const result = await delivery.result;
console.log(result.delivered);
```

`await jobs.sendEmail(input)` waits until the queue accepts the job and returns
a handle. It does not wait for the handler. Await `handle.result` only when the
caller needs the result. Ignoring a handle is safe and does not create an
unhandled rejected promise.

Schemas are optional. A plain handler also infers its result:

```ts
const jobs = enqiu({
  resizeImage: async (input: { key: string; width: number }) => {
    return { key: input.key, width: input.width };
  },
});
```

## Redis

Inject an existing client; Enqiu does not create connections or install a Redis
library. It accepts Bun's `send(command, args)` client shape and node-redis'
`sendCommand(args)` shape.

```ts
import { createClient } from "redis";
import { enqiu, redis } from "enqiu";

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const jobs = enqiu(definitions, {
  name: "notifications",
  driver: redis(client),
  worker: { concurrency: 20 },
});
```

Use the same definitions in a producer-only process:

```ts
const jobs = enqiu(definitions, {
  name: "notifications",
  driver: redis(client),
  worker: false,
});
```

Redis jobs use atomic Lua transitions, visibility leases, and deterministic
recovery so multiple Node.js or Bun workers can safely share a queue.

## Job policies

Policies live beside the handler and keep call sites clean. Durations are
numbers in milliseconds, so applications may use plain numbers or a helper
such as `ms("30s")` without making it an Enqiu dependency.

```ts
const jobs = enqiu({
  syncAccount: job({
    input: z.object({
      tenantId: z.string(),
      accountId: z.string(),
    }),
    retry: {
      attempts: 5,
      backoff: { type: "exponential", delay: 250, jitter: 0.2 },
    },
    timeout: 30_000,
    expiresIn: 5 * 60_000,
    concurrency: {
      limit: 2,
      by: (input) => input.tenantId,
    },
    throttle: {
      limit: 100,
      per: 60_000,
      burst: 10,
      by: (input) => input.tenantId,
    },
    run: async (input, context) => {
      return syncAccount(input, { signal: context.signal });
    },
  }),
});
```

- `concurrency` limits simultaneous work globally or by a key such as tenant.
- `throttle` limits starts over time; `burst` allows short spikes.
- `debounce: { mode: "leading" }` keeps the first call in a window.
- `debounce: { mode: "trailing" }` keeps the most recent call in a window.
- `expiresIn` prevents stale jobs from starting.
- `idempotencyKey` makes repeated submissions return the same job.

Per-call delivery options are available when needed:

```ts
const handle = await jobs.syncAccount(input, {
  idempotencyKey: `sync:${input.accountId}`,
  idempotencyTtl: 24 * 60 * 60_000,
  delay: 5_000,
  priority: "high",
});
```

## Progress and logs

Progress uses real units rather than an ambiguous fraction:

```ts
const jobs = enqiu({
  importRows: async (rows: string[], context) => {
    for (let index = 0; index < rows.length; index += 1) {
      await importRow(rows[index]);
      await context.reportProgress({
        completed: index + 1,
        total: rows.length,
        message: "Importing rows",
      });
    }

    context.log.info("Import complete", { rows: rows.length });
  },
});
```

Subscribe to lifecycle events with `jobs.queue.on(...)`. Memory events stay
inside the process; Redis events are shared between producers and workers.

## Cron schedules

Schedules use standard five-field cron expressions and IANA time zones:

```ts
const schedule = await jobs.sendDigest.schedule({
  id: "weekday-digest",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Nicosia",
  input: { audience: "daily" },
  catchUp: true,
});

await schedule.pause();
await schedule.resume();
await schedule.remove();
```

Memory schedules live for the process lifetime. Redis schedules are durable
and use deterministic occurrence IDs to avoid duplicate runs.

## Hono

Enqiu uses Standard Schema and exposes each job's input schema, so the same
schema can validate an HTTP route without redefining a type:

```ts
import { sValidator } from "@hono/standard-validator";

app.post(
  "/emails",
  sValidator("json", jobs.sendEmail.input),
  async (c) => {
    const handle = await jobs.sendEmail(c.req.valid("json"));
    return c.json({ id: handle.id }, 202);
  },
);
```

Hono and `@hono/standard-validator` are optional application dependencies.

## Queue and worker controls

```ts
await jobs.queue.pause();
await jobs.queue.resume();
await jobs.queue.setConcurrency(50);

const page = await jobs.queue.list({ status: "failed", limit: 100 });
const snapshot = await jobs.queue.get(handle.id);
await jobs.queue.redrive(handle.id);
await jobs.queue.cleanup({ olderThan: Date.now() - 7 * 24 * 60 * 60_000 });

await jobs.worker.pause();
await jobs.worker.resume();
await jobs.worker.onIdle();
await jobs.worker.close();
```

## Runtime support

- Node.js 20 and newer
- Current stable Bun
- Memory and Redis drivers
- ESM and TypeScript declarations

## License

MIT
