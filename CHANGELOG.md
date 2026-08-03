# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
