# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [0.2.0-alpha.0] - 2026-08-06

Enqiu is now labelled alpha and published under the `alpha` dist-tag, so
`npm install enqiu` will not resolve to it. It is not suitable for production:
the API will keep breaking without a deprecation period, and neither the
durability guarantees nor the Redis driver have been validated under sustained
real-world load.

### Breaking

- `RedisEnqiuOptions` is now `DriverEnqiuOptions`, and its `driver` field is
  typed as `DriverFactory` rather than `RedisDriver`. Any driver factory is
  accepted, which is what makes the backend an extension point rather than a
  hard-coded pair.
- The Redis driver now rejects a `historyLimit` below 1 instead of silently
  clamping it. The in-memory driver still accepts 0; Redis trims its terminal
  lists with `LTRIM`, which cannot express "retain nothing".

### Added

- A `QueueDriver` seam (`src/driver.ts`) that both backends implement, with
  `DriverFactory` carrying its own queue constructor.
- Cursor pagination for `queue.list()` on the in-memory driver, matching the
  Redis driver's offset semantics.
- `pnpm run test:coverage`, with thresholds enforced in `vitest.config.ts`.

### Changed

- The package is tree-shakable. `api.ts` no longer imports the Redis driver, so
  a memory-only bundle drops from 137,786 to 72,562 bytes (-47%), losing all 215
  lines of Lua and the `RedisQueue` class. Importing `redis()` still pulls them
  in, as it should.
- `MemoryQueue` keeps live per-status counters instead of scanning its record
  map, so `size` and `stats` are O(1). Pushing 20,000 jobs through a
  concurrency-64 queue went from 3,102ms to 144ms (6,447 to 139,370 jobs/sec).
- Validators, error serialization, and backoff arithmetic moved into
  `src/internal/`, replacing per-driver copies. Both drivers now reject a
  non-finite or negative backoff delay rather than the Redis driver clamping it.

### Fixed

- **Queue events never fired on the Redis driver.** `node-redis` returns `XREAD`
  as an object keyed by stream name (and a `Map` under RESP3), while RESP2
  clients and Bun's return a nested array. The stream parser bailed on anything
  that was not an array, so it always produced zero entries — `queue.on(...)`
  and telemetry forwarding subscribed successfully and then stayed silent
  forever. `XREVRANGE` does return an array, which is why cursor setup worked
  and hid the fault.
- A bad `logLimit` was reported as `historyLimit must be a non-negative integer`,
  because the validator hardcoded the wrong field name.
- `queue.list({ cursor })` was honoured by Redis and silently ignored in memory,
  so code that paginated correctly against Redis re-read page one forever
  against the in-memory driver.
- `list.limit` was range-checked by Redis but not by the in-memory driver.
- `MemoryQueue.cleanup` kept scanning every remaining record after it reached
  the requested limit.
- Removed two unused functions from the Redis driver that `noUnusedLocals`,
  being disabled, never flagged.

### Internal

- Test count rose from 36 to 134, all of which now run: the Redis suite was
  verified against Redis 7.4.10 through `node-redis`. Coverage is 96.42% of
  statements without Redis and 95.02% with it, and `src/redis.ts` rose from
  81.13% to 93.09%. `src/internal/` is fully covered.
- Fixed test isolation in the Redis suite. It called `flushDb()` before every
  test, wiping a database that Vitest's parallel test files were using at the
  same time, which made `examples/testing/jobs.redis.test.ts` fail roughly one
  run in three. Each test now owns a namespace and cleans up only its own keys,
  which is what the README already claimed. Doing that exposed a second latent
  coupling: the cron test hardcoded the default `enqiu:` key prefix.
- Resolved Airbnb style-guide violations in `src`: `no-plusplus`,
  `no-underscore-dangle`, `no-nested-ternary`, and an unused import.

## [0.1.3] - 2026-08-03

### Added

- Added an explicit browser export for the in-memory queue, with browser usage
  guidance and a live React landing example powered by the packaged Enqiu runtime.
  Browser queues run in the current tab and are intentionally non-durable;
  Redis remains a server-runtime driver.
- Added a React queue playground at `/playground` for composing, running,
  inspecting, cancelling, retrying, and redriving real in-browser jobs.

### Fixed

- Allowed strict TypeScript handlers to combine typed inputs with `JobContext`.
- Made memory-driver cleanup honor requested terminal statuses instead of
  removing every terminal job.

## [0.1.2] - 2026-08-02

### Added

- Added runnable Vitest consumer examples for the in-memory driver and an
  opt-in Redis integration using isolated namespaces and deterministic cleanup.
- Added `pnpm test:example` and README guidance for testing application jobs
  through Enqiu's public API.

## [0.1.1] - 2026-08-02

### Changed

- Updated the package contact email to `it@worksonmy.dev`.

## [0.1.0] - 2026-07-27

### Changed

- Renamed the package and primary API to `enqiu`.
- Replaced the BullMQ wrapper with first-party memory and Redis drivers.
- Reworked the API around inferred named handlers and direct job calls.

### Added

- Typed heterogeneous job maps.
- Concurrency control with priority scheduling.
- Delayed jobs and exact-date scheduling.
- Per-queue and per-job retries with fixed, exponential, custom, and jittered
  backoff.
- Cooperative cancellation and per-attempt timeouts using `AbortSignal`.
- Strict rolling-window rate limiting and producer backpressure.
- Single-flight deduplication keys.
- Bulk enqueueing, progress reporting, typed lifecycle events, history,
  cleanup, pause/start, inspection, and graceful close.
- Safe fire-and-forget jobs without implicit unhandled promise rejections.
- Durable Redis delivery, cron schedules, keyed concurrency, throttling,
  debouncing, expiration, structured logs, and telemetry hooks.

### Removed

- BullMQ and its transitive runtime dependency tree.
- The mismatched legacy constructor and undocumented aliases.
