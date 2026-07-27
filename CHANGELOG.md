# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

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
