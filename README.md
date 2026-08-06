# Enqiu

[![npm](https://img.shields.io/npm/v/enqiu/alpha?style=flat-square&label=alpha)](https://www.npmjs.com/package/enqiu)
[![status](https://img.shields.io/badge/status-alpha-d97706?style=flat-square)](#status-alpha)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-1f6f43?style=flat-square)](https://nodejs.org/)
[![runtime dependencies](https://img.shields.io/badge/runtime_deps-0-f05a28?style=flat-square)](package.json)
[![license](https://img.shields.io/npm/l/enqiu?style=flat-square)](LICENSE)

A small, type-safe job queue for browsers, Node.js, and Bun. Run jobs in memory
wherever JavaScript runs, then move server workloads to Redis without changing
your job API.

[Live overview](https://enqiu.worksonmy.dev) ·
[npm](https://www.npmjs.com/package/enqiu) ·
[Project notes](https://worksonmy.dev/projects/enqiu) ·
[Issues](https://github.com/moji2002/enqiu/issues)

## Status: alpha

> [!WARNING]
> **Enqiu is alpha software. Do not run it in production.**
>
> The API is still changing and will break between releases without a
> deprecation period. Durability, failure handling, and the Redis driver have
> not been validated under sustained real-world load. There is no security
> review and no support commitment.
>
> It is published under the `alpha` dist-tag, so a plain `npm install enqiu`
> will not install it. You have to ask for it by name.

```bash
npm install enqiu@alpha
# or: pnpm add enqiu@alpha
# or: bun add enqiu@alpha
```

Use it for prototypes, local tooling, and evaluation. If you depend on it, pin
the exact version — `^` and `~` ranges do not behave the way you expect across
prerelease versions.

Enqiu has no runtime dependencies. Redis, schema, Hono, and telemetry packages
remain your choice.

The memory driver runs in modern browsers as an in-tab, non-durable queue. It
fits local-first workflows, client-side processing, and interactive tools. Use
Redis from a server runtime when work must survive page closes or be shared
across processes.

## Quick start

Define each job once, then call it like a function. The name, input, and result
types are inferred.

```ts
import { enqiu } from "enqiu";

const jobs = enqiu({
  sendEmail: async (
    email: { to: string; subject: string },
    { log },
  ) => {
    log.info("Sending email", { to: email.to });
    return { delivered: true, subject: email.subject };
  },
});

const delivery = await jobs.sendEmail({
  to: "hello@example.com",
  subject: "Welcome",
});

const result = await delivery.result;
console.log(result.delivered);
await jobs.worker.close();
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

## Testing in your project

Create a fresh queue for each test so workers and queued state never leak
between cases. This Vitest example uses the in-memory driver, awaits the public
job handle, checks the persisted status, and always closes the worker:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createJobs } from "./jobs.js";

let jobs: ReturnType<typeof createJobs> | undefined;

afterEach(async () => {
  await jobs?.worker.close();
  jobs = undefined;
});

describe("email jobs", () => {
  it("returns and stores the handler result", async () => {
    jobs = createJobs();
    const handle = await jobs.sendWelcome({ name: "Ada" });

    await expect(handle.result).resolves.toEqual({ subject: "Welcome, Ada" });
    expect((await handle.refresh()).status).toBe("succeeded");
  });
});
```

Install and run it with:

```bash
pnpm add enqiu
pnpm add -D vitest
pnpm vitest run
```

The repository keeps the complete, runnable
[memory and opt-in Redis examples](https://github.com/moji2002/enqiu/tree/main/examples/testing).
The Redis test runs only when `ENQIU_TEST_REDIS_URL` is set, uses a unique
namespace instead of flushing the database, and closes the worker before the
injected Redis client.

### Enqiu's own test coverage

The suite runs on Vitest with V8 coverage. `pnpm run check` runs both
type-checks, the coverage-gated suite, and the build:

```bash
pnpm run test            # 116 tests; 134 with a Redis server
pnpm run test:coverage   # same, with the coverage report and thresholds
pnpm run check           # typecheck + typecheck:test + coverage + build
```

The Redis driver needs a live server. Without one its 18 tests are skipped
rather than failed, and `src/redis.ts` drops out of the coverage report, so the
reported percentage always reflects code the run actually exercised:

```bash
docker run -d -p 6379:6379 redis:7-alpine
ENQIU_TEST_REDIS_URL=redis://localhost:6379 pnpm run test:coverage
```

Coverage is enforced in `vitest.config.ts` and the build fails below the
threshold for whichever mode is running:

| Metric     | Default | Threshold | With Redis | Threshold |
| ---------- | ------- | --------- | ---------- | --------- |
| Statements | 96.42%  | 95%       | 95.02%     | 94%       |
| Branches   | 91.36%  | 90%       | 86.53%     | 85%       |
| Functions  | 93.69%  | 93%       | 93.10%     | 92%       |
| Lines      | 96.42%  | 95%       | 95.02%     | 94%       |

`src/internal/` is at 100% on every metric. The Redis run covers strictly more
code — it adds `src/redis.ts` at 93.09% — but that module's Lua-adjacent guards
are hard to drive from the outside, which is why its branch bar sits lower.

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

## Operational boundaries

- The memory driver is process-local and non-durable; use it for local work,
  tests, and jobs that may disappear with the process.
- Redis mode needs an existing compatible Redis client. Enqiu does not own that
  client's connection lifecycle.
- Job inputs and results must be JSON-safe. Functions, streams, class instances,
  sparse arrays, and `undefined` fields are not portable queue data.
- Retries and worker recovery can run a job more than once. Make external side
  effects idempotent when duplicate execution would be harmful.
- Enqiu coordinates jobs; it is not a distributed transaction coordinator.

## License

MIT
