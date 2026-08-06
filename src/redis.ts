import {
  JobCancelledError,
  JobExpiredError,
  JobFailedError,
  JobTimeoutError,
  QueueClosedError,
} from "./memory.js";
import type {
  AddOptions,
  JobContext,
  JobInput,
  JobLogEntry,
  JobMap,
  JobName,
  JobOutput,
  JobSnapshot,
  JobStatus,
  QueueEventMap,
  QueueOptions,
  QueueStats,
  RateLimitOptions,
} from "./memory.js";
import {
  errorFromSerialized,
  serializeError,
  toError,
  type SerializedError,
} from "./internal/errors.js";
import {
  backoffFromOptions,
  resolveRunAt,
  sleep,
  type BackoffOptions,
} from "./internal/timing.js";
import {
  nonNegativeInteger,
  nonNegativeNumber,
  positiveInteger,
  positiveIntegerOrInfinity,
  positiveNumber,
} from "./internal/validate.js";
import {
  decodeJobValue as decode,
  encodeJobValue as encode,
} from "./codec.js";
import {
  nextCronOccurrence,
  parseCron,
  validateTimeZone,
} from "./cron.js";
import { compact } from "./internal/object.js";
import type {
  DriverCleanupQuery,
  DriverFactory,
  DriverHandlers,
  DriverJob,
  DriverListPage,
  DriverListQuery,
  DriverQueueOptions,
  DriverScheduleRegistration,
  QueueDriver,
  ScheduleHandle,
  ScheduleSnapshot,
} from "./driver.js";

export interface RedisCommandClient {
  /** Bun's native RedisClient shape. */
  send?(command: string, arguments_: string[]): Promise<unknown>;
  /** node-redis and compatible clients. */
  sendCommand?(arguments_: string[]): Promise<unknown>;
}

export interface RedisDriverOptions {
  /** Redis key namespace. @default "enqiu" */
  prefix?: string;
  /** Worker polling interval in milliseconds. @default 100 */
  pollInterval?: number;
  /** Time before work owned by a dead worker is reclaimed. @default 30000 */
  visibilityTimeout?: number;
  /** Terminal job metadata retention in milliseconds. @default 604800000 */
  retention?: number;
}

/** Connection and tuning values every RedisQueue instance reads. */
export interface RedisDriverConfig {
  readonly client: RedisCommandClient;
  readonly prefix: string;
  readonly pollInterval: number;
  readonly visibilityTimeout: number;
  readonly retention: number;
}

/**
 * What `redis()` returns and `enqiu()` accepts.
 *
 * It carries its own queue constructor, so the facade depends on the
 * `DriverFactory` type rather than on this module. That missing import edge
 * is what lets a bundler drop this file — and the Lua it holds — from an
 * application that only uses the in-memory driver.
 */
export interface RedisDriver extends RedisDriverConfig, DriverFactory {
  readonly kind: "redis";
}

export interface RedisRetryOptions {
  retries: number;
  backoff?: number | BackoffOptions;
}

export interface RedisAddOptions
  extends Omit<AddOptions, "retry"> {
  retry?: number | RedisRetryOptions;
}

export interface RedisQueueOptions
  extends Omit<QueueOptions, "retry" | "historyLimit"> {
  driver: RedisDriverConfig;
  /**
   * Terminal jobs retained per status list. Must be at least 1; unlike the
   * in-memory driver, this one cannot retain nothing. @default 1000
   */
  historyLimit?: number;
  /**
   * Start a local worker for these handlers. Set `false` in producer-only
   * processes. @default true
   */
  worker?: boolean;
  retry?: number | RedisRetryOptions;
}

export interface RedisJob<
  Output = unknown,
  Input = unknown,
  Name extends string = string,
> {
  readonly id: string;
  readonly name: Name;
  readonly input: Input;
  readonly status: JobStatus;
  readonly deduplicated: boolean;
  /** Resolves after Redis atomically accepts the job. */
  readonly accepted: Promise<void>;
  readonly result: Promise<Output>;
  cancel(reason?: string): Promise<boolean>;
  refresh(): Promise<JobSnapshot<Input, Output, Name>>;
}

export interface RedisQueueEventMap extends QueueEventMap {
  error: Error;
  recovered: JobSnapshot;
}

export interface RedisListOptions {
  status?: JobStatus;
  name?: string;
  before?: number;
  after?: number;
  limit?: number;
  cursor?: string;
}

export interface RedisListPage {
  jobs: JobSnapshot[];
  cursor?: string;
}

export interface RedisScheduleRegistration
  extends Omit<DriverScheduleRegistration, "submit"> {
  /** Redis cannot carry a `when` predicate across the process boundary. */
  submit: RedisAddOptions;
}

export type RedisScheduleSnapshot = ScheduleSnapshot;
export type RedisScheduleHandle = ScheduleHandle;

interface RedisJobRecord {
  id: string;
  name: string;
  input: unknown;
  status: JobStatus;
  priority: number;
  attempt: number;
  retry: NormalizedRedisRetry;
  timeout: number | undefined;
  expiresAt: number | undefined;
  keyRetention: number;
  concurrency: RedisAddOptions["concurrency"];
  throttle: RedisAddOptions["throttle"];
  debounce: RedisAddOptions["debounce"];
  createdAt: number;
  runAt: number;
  startedAt: number | undefined;
  finishedAt: number | undefined;
  progress: unknown;
  output: unknown;
  error: SerializedError | undefined;
  logs: JobLogEntry[];
  deduplicated: boolean;
  submission: Promise<void>;
  submissionError: Error | undefined;
}

interface NormalizedRedisRetry {
  retries: number;
  backoff: number | BackoffOptions | undefined;
}

interface ClaimedJob {
  id: string;
  name: string;
  input: unknown;
  attempt: number;
  retry: NormalizedRedisRetry;
  timeout: number | undefined;
  token: string;
}

const ENQUEUE_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
if redis.call('EXISTS', meta) == 1 then
  return {'duplicate', ARGV[1]}
end

if ARGV[9] ~= '' then
  local existing = redis.call('HGET', KEYS[7], ARGV[9])
  if existing then
    local existing_meta = KEYS[1] .. existing
    local state = redis.call('HGET', existing_meta, 'status')
    local trailing_update = (
      ARGV[21] == 'trailing' and
      ARGV[19] ~= '' and
      (state == 'queued' or state == 'scheduled')
    )
    if (
      state == 'running' or
      ((state == 'queued' or state == 'scheduled') and not trailing_update)
    ) then
      return {'deduplicated', existing}
    end
    if not trailing_update then
      local key_expires_at = tonumber(
        redis.call('HGET', existing_meta, 'keyExpiresAt') or '0'
      )
      if key_expires_at > tonumber(ARGV[6]) then
        return {'deduplicated', existing}
      end
      redis.call('HDEL', KEYS[7], ARGV[9])
    end
  end
end

local debounce_key = ARGV[19]
if debounce_key ~= '' then
  local existing = redis.call('HGET', KEYS[9], debounce_key)
  if existing then
    local existing_meta = KEYS[1] .. existing
    local state = redis.call('HGET', existing_meta, 'status')
    local until_at = tonumber(
      redis.call('HGET', existing_meta, 'debounceUntil') or '0'
    )
    if ARGV[21] == 'leading' and until_at > tonumber(ARGV[6]) then
      return {'deduplicated', existing}
    end
    if ARGV[21] == 'trailing' and (
      state == 'queued' or state == 'scheduled'
    ) then
      local member = redis.call('HGET', existing_meta, 'member')
      local next_run = math.max(
        tonumber(ARGV[5]),
        tonumber(ARGV[6]) + tonumber(ARGV[20])
      )
      local next_until = tonumber(ARGV[6]) + tonumber(ARGV[20])
      redis.call('ZREM', KEYS[3], member)
      redis.call('ZREM', KEYS[4], existing)
      redis.call(
        'HSET',
        existing_meta,
        'input', ARGV[3],
        'priority', ARGV[4],
        'runAt', tostring(next_run),
        'status', 'scheduled',
        'retries', ARGV[7],
        'backoff', ARGV[8],
        'timeout', ARGV[10],
        'expiresAt', ARGV[11],
        'keyRetention', ARGV[12],
        'concurrencyKey', ARGV[13],
        'concurrencyLimit', ARGV[14],
        'throttleKey', ARGV[15],
        'throttleLimit', ARGV[16],
        'throttleInterval', ARGV[17],
        'throttleBurst', ARGV[18],
        'debounceUntil', tostring(next_until),
        'debounceMode', ARGV[21]
      )
      redis.call('ZADD', KEYS[4], next_run, existing)
      if ARGV[11] ~= '' then
        redis.call('ZADD', KEYS[8], ARGV[11], existing)
      else
        redis.call('ZREM', KEYS[8], existing)
      end
      redis.call('ZADD', KEYS[10], next_until, debounce_key)
      if ARGV[9] ~= '' then
        redis.call('HSET', KEYS[7], ARGV[9], existing)
        redis.call('HSET', existing_meta, 'key', ARGV[9])
      end
      redis.call(
        'XADD', KEYS[11], 'MAXLEN', '~', '10000', '*',
        'type', 'added', 'id', existing, 'at', ARGV[6]
      )
      return {'debounced', existing}
    end
    if not state or until_at <= tonumber(ARGV[6]) then
      redis.call('HDEL', KEYS[9], debounce_key)
      redis.call('ZREM', KEYS[10], debounce_key)
    end
  end
end

local sequence = redis.call('INCR', KEYS[2])
local member = string.format('%020d', sequence) .. '|' .. ARGV[1]
local state = 'queued'
local run_at = tonumber(ARGV[5])
if ARGV[21] == 'trailing' then
  run_at = math.max(run_at, tonumber(ARGV[6]) + tonumber(ARGV[20]))
end
if run_at > tonumber(ARGV[6]) then
  state = 'scheduled'
end
local debounce_until = ''
if debounce_key ~= '' then
  debounce_until = tostring(tonumber(ARGV[6]) + tonumber(ARGV[20]))
end

redis.call(
  'HSET',
  meta,
  'id', ARGV[1],
  'name', ARGV[2],
  'input', ARGV[3],
  'priority', ARGV[4],
  'runAt', tostring(run_at),
  'createdAt', ARGV[6],
  'status', state,
  'attempt', '0',
  'retries', ARGV[7],
  'backoff', ARGV[8],
  'timeout', ARGV[10],
  'member', member,
  'key', ARGV[9],
  'expiresAt', ARGV[11],
  'keyRetention', ARGV[12],
  'concurrencyKey', ARGV[13],
  'concurrencyLimit', ARGV[14],
  'throttleKey', ARGV[15],
  'throttleLimit', ARGV[16],
  'throttleInterval', ARGV[17],
  'throttleBurst', ARGV[18],
  'debounceKey', debounce_key,
  'debounceUntil', debounce_until,
  'debounceMode', ARGV[21]
)

if ARGV[9] ~= '' then
  redis.call('HSET', KEYS[7], ARGV[9], ARGV[1])
end
if ARGV[11] ~= '' then
  redis.call('ZADD', KEYS[8], ARGV[11], ARGV[1])
end
if debounce_key ~= '' then
  redis.call('HSET', KEYS[9], debounce_key, ARGV[1])
  redis.call('ZADD', KEYS[10], debounce_until, debounce_key)
end
if state == 'scheduled' then
  redis.call('ZADD', KEYS[4], run_at, ARGV[1])
else
  redis.call('ZADD', KEYS[3], -tonumber(ARGV[4]), member)
end
redis.call('ZADD', KEYS[12], ARGV[6], ARGV[1])
redis.call(
  'XADD', KEYS[11], 'MAXLEN', '~', '10000', '*',
  'type', 'added', 'id', ARGV[1], 'at', ARGV[6]
)
return {'added', ARGV[1]}
`;

const CLAIM_SCRIPT = `
local now = tonumber(ARGV[1])
local token = ARGV[2]
local visibility = tonumber(ARGV[3])
local batch = tonumber(ARGV[6])
local retention = tonumber(ARGV[8])
local history_limit = tonumber(ARGV[9])

local function release_concurrency(meta)
  local concurrency_key = redis.call('HGET', meta, 'concurrencyKey')
  if concurrency_key and concurrency_key ~= '' then
    local active = redis.call('HINCRBY', KEYS[12], concurrency_key, -1)
    if active <= 0 then
      redis.call('HDEL', KEYS[12], concurrency_key)
    end
  end
end

local function finish_key(meta, finished_at)
  local dedupe = redis.call('HGET', meta, 'key')
  local key_retention = tonumber(
    redis.call('HGET', meta, 'keyRetention') or '0'
  )
  if dedupe and dedupe ~= '' then
    if key_retention > 0 then
      redis.call(
        'HSET',
        meta,
        'keyExpiresAt',
        tostring(finished_at + key_retention)
      )
    else
      redis.call('HDEL', KEYS[8], dedupe)
    end
  end
  return math.max(retention, key_retention)
end

local expired_debounce = redis.call(
  'ZRANGEBYSCORE', KEYS[17], '-inf', now, 'LIMIT', 0, batch
)
for _, debounce_key in ipairs(expired_debounce) do
  local id = redis.call('HGET', KEYS[16], debounce_key)
  if id then
    local meta = KEYS[1] .. id
    local until_at = tonumber(
      redis.call('HGET', meta, 'debounceUntil') or '0'
    )
    if until_at <= now then
      redis.call('HDEL', KEYS[16], debounce_key)
      redis.call('ZREM', KEYS[17], debounce_key)
    end
  else
    redis.call('ZREM', KEYS[17], debounce_key)
  end
end

local due = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, batch)
for _, id in ipairs(due) do
  local meta = KEYS[1] .. id
  if redis.call('HGET', meta, 'status') == 'scheduled' then
    local member = redis.call('HGET', meta, 'member')
    local priority = tonumber(redis.call('HGET', meta, 'priority') or '0')
    redis.call('ZADD', KEYS[2], -priority, member)
    redis.call('HSET', meta, 'status', 'queued')
  end
  redis.call('ZREM', KEYS[3], id)
end

local stale = redis.call(
  'ZRANGEBYSCORE', KEYS[9], '-inf', now, 'LIMIT', 0, batch
)
for _, id in ipairs(stale) do
  local meta = KEYS[1] .. id
  local state = redis.call('HGET', meta, 'status')
  if state == 'queued' or state == 'scheduled' then
    local member = redis.call('HGET', meta, 'member')
    redis.call('ZREM', KEYS[2], member)
    redis.call('ZREM', KEYS[3], id)
    redis.call(
      'HSET',
      meta,
      'status', 'expired',
      'finishedAt', ARGV[1],
      'error', ARGV[10]
    )
    local ttl = finish_key(meta, now)
    redis.call('LPUSH', KEYS[10], id)
    redis.call('LTRIM', KEYS[10], 0, history_limit - 1)
    redis.call('PEXPIRE', meta, ttl)
    redis.call(
      'XADD', KEYS[15], 'MAXLEN', '~', '10000', '*',
      'type', 'expired', 'id', id, 'at', ARGV[1]
    )
  end
  redis.call('ZREM', KEYS[9], id)
end

local expired = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now, 'LIMIT', 0, batch)
for _, id in ipairs(expired) do
  local meta = KEYS[1] .. id
  if redis.call('HGET', meta, 'status') == 'running' then
    release_concurrency(meta)
    local attempt = tonumber(redis.call('HGET', meta, 'attempt') or '1')
    local retries = tonumber(redis.call('HGET', meta, 'retries') or '0')
    redis.call('HDEL', meta, 'token')
    if attempt <= retries then
      local member = redis.call('HGET', meta, 'member')
      local priority = tonumber(redis.call('HGET', meta, 'priority') or '0')
      redis.call('ZADD', KEYS[2], -priority, member)
      redis.call('HSET', meta, 'status', 'queued', 'error', ARGV[7])
      local expires_at = redis.call('HGET', meta, 'expiresAt')
      if expires_at and expires_at ~= '' then
        redis.call('ZADD', KEYS[9], expires_at, id)
      end
      redis.call(
        'XADD', KEYS[15], 'MAXLEN', '~', '10000', '*',
        'type', 'recovered', 'id', id, 'at', ARGV[1]
      )
    else
      redis.call(
        'HSET',
        meta,
        'status', 'failed',
        'finishedAt', ARGV[1],
        'error', ARGV[7]
      )
      redis.call('LPUSH', KEYS[7], id)
      redis.call('LTRIM', KEYS[7], 0, history_limit - 1)
      local ttl = finish_key(meta, now)
      redis.call('PEXPIRE', meta, ttl)
      redis.call(
        'XADD', KEYS[15], 'MAXLEN', '~', '10000', '*',
        'type', 'failed', 'id', id, 'at', ARGV[1]
      )
    end
  end
  redis.call('ZREM', KEYS[4], id)
end

if redis.call('HGET', KEYS[11], 'paused') == '1' then
  return {'paused'}
end
local global_concurrency = tonumber(
  redis.call('HGET', KEYS[11], 'concurrency') or '0'
)
if global_concurrency > 0 and redis.call('ZCARD', KEYS[4]) >= global_concurrency then
  return {'concurrency'}
end

local rate_limit = tonumber(ARGV[4])
if rate_limit > 0 then
  local interval = tonumber(ARGV[5])
  redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now - interval)
  if redis.call('ZCARD', KEYS[5]) >= rate_limit then
    return {'rate'}
  end
end

local entries = redis.call('ZRANGE', KEYS[2], 0, batch - 1)
if #entries == 0 then
  return {'empty'}
end

local member = nil
local id = nil
for _, candidate in ipairs(entries) do
  local separator = string.find(candidate, '|', 1, true)
  local candidate_id = string.sub(candidate, separator + 1)
  local candidate_meta = KEYS[1] .. candidate_id
  if redis.call('HGET', candidate_meta, 'status') == 'queued' then
    local allowed = true
    local concurrency_key = redis.call(
      'HGET', candidate_meta, 'concurrencyKey'
    )
    local concurrency_limit = tonumber(
      redis.call('HGET', candidate_meta, 'concurrencyLimit') or '0'
    )
    if concurrency_key and concurrency_key ~= '' and concurrency_limit > 0 then
      local active = tonumber(
        redis.call('HGET', KEYS[12], concurrency_key) or '0'
      )
      if active >= concurrency_limit then
        allowed = false
      end
    end

    local throttle_key = redis.call('HGET', candidate_meta, 'throttleKey')
    local throttle_limit = tonumber(
      redis.call('HGET', candidate_meta, 'throttleLimit') or '0'
    )
    if allowed and throttle_key and throttle_key ~= '' and throttle_limit > 0 then
      local interval = tonumber(
        redis.call('HGET', candidate_meta, 'throttleInterval') or '1'
      )
      local burst = tonumber(
        redis.call('HGET', candidate_meta, 'throttleBurst') or '1'
      )
      local tokens = tonumber(
        redis.call('HGET', KEYS[13], throttle_key) or tostring(burst)
      )
      local updated = tonumber(
        redis.call('HGET', KEYS[14], throttle_key) or tostring(now)
      )
      tokens = math.min(
        burst,
        tokens + math.max(0, now - updated) * (throttle_limit / interval)
      )
      redis.call('HSET', KEYS[13], throttle_key, tostring(tokens))
      redis.call('HSET', KEYS[14], throttle_key, tostring(now))
      if tokens < 1 then
        allowed = false
      end
    end

    if allowed then
      member = candidate
      id = candidate_id
      break
    end
  end
end

if not member or not id then
  return {'policy'}
end

redis.call('ZREM', KEYS[2], member)
local meta = KEYS[1] .. id
if redis.call('HGET', meta, 'status') ~= 'queued' then
  return {'empty'}
end

local concurrency_key = redis.call('HGET', meta, 'concurrencyKey')
if concurrency_key and concurrency_key ~= '' then
  redis.call('HINCRBY', KEYS[12], concurrency_key, 1)
end
local throttle_key = redis.call('HGET', meta, 'throttleKey')
if throttle_key and throttle_key ~= '' then
  redis.call('HINCRBYFLOAT', KEYS[13], throttle_key, -1)
end

local attempt = redis.call('HINCRBY', meta, 'attempt', 1)
redis.call(
  'HSET',
  meta,
  'status', 'running',
  'startedAt', ARGV[1],
  'token', token
)
redis.call('ZADD', KEYS[4], now + visibility, id)
redis.call('ZREM', KEYS[9], id)
if rate_limit > 0 then
  redis.call('ZADD', KEYS[5], now, token)
end
redis.call(
  'XADD', KEYS[15], 'MAXLEN', '~', '10000', '*',
  'type', 'started', 'id', id, 'at', ARGV[1]
)

return {
  'job',
  id,
  redis.call('HGET', meta, 'name'),
  redis.call('HGET', meta, 'input'),
  tostring(attempt),
  redis.call('HGET', meta, 'retries'),
  redis.call('HGET', meta, 'backoff'),
  redis.call('HGET', meta, 'timeout')
}
`;

const HEARTBEAT_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
if redis.call('HGET', meta, 'token') ~= ARGV[2] then
  return 0
end
if redis.call('HGET', meta, 'status') ~= 'running' then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`;

const COMPLETE_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
if redis.call('HGET', meta, 'token') ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[1])
local concurrency_key = redis.call('HGET', meta, 'concurrencyKey')
if concurrency_key and concurrency_key ~= '' then
  local active = redis.call('HINCRBY', KEYS[5], concurrency_key, -1)
  if active <= 0 then
    redis.call('HDEL', KEYS[5], concurrency_key)
  end
end
redis.call(
  'HSET',
  meta,
  'status', 'succeeded',
  'finishedAt', ARGV[3],
  'output', ARGV[4]
)
redis.call('HDEL', meta, 'token')
local dedupe = redis.call('HGET', meta, 'key')
local key_retention = tonumber(
  redis.call('HGET', meta, 'keyRetention') or '0'
)
if dedupe and dedupe ~= '' then
  if key_retention > 0 then
    redis.call(
      'HSET',
      meta,
      'keyExpiresAt',
      tostring(tonumber(ARGV[3]) + key_retention)
    )
  else
    redis.call('HDEL', KEYS[4], dedupe)
  end
end
redis.call('LPUSH', KEYS[3], ARGV[1])
redis.call('LTRIM', KEYS[3], 0, tonumber(ARGV[6]) - 1)
redis.call('PEXPIRE', meta, math.max(tonumber(ARGV[5]), key_retention))
redis.call(
  'XADD', KEYS[6], 'MAXLEN', '~', '10000', '*',
  'type', 'succeeded', 'id', ARGV[1], 'at', ARGV[3]
)
return 1
`;

const FAIL_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
if redis.call('HGET', meta, 'token') ~= ARGV[2] then
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HDEL', meta, 'token')
redis.call('HSET', meta, 'error', ARGV[4])
local concurrency_key = redis.call('HGET', meta, 'concurrencyKey')
if concurrency_key and concurrency_key ~= '' then
  local active = redis.call('HINCRBY', KEYS[7], concurrency_key, -1)
  if active <= 0 then
    redis.call('HDEL', KEYS[7], concurrency_key)
  end
end

if ARGV[3] == '1' then
  local run_at = tonumber(ARGV[5])
  local member = redis.call('HGET', meta, 'member')
  local priority = tonumber(redis.call('HGET', meta, 'priority') or '0')
  if run_at > tonumber(ARGV[6]) then
    redis.call('HSET', meta, 'status', 'scheduled', 'runAt', ARGV[5])
    redis.call('ZADD', KEYS[4], run_at, ARGV[1])
  else
    redis.call('HSET', meta, 'status', 'queued', 'runAt', ARGV[5])
    redis.call('ZADD', KEYS[3], -priority, member)
  end
  local expires_at = redis.call('HGET', meta, 'expiresAt')
  if expires_at and expires_at ~= '' then
    redis.call('ZADD', KEYS[8], expires_at, ARGV[1])
  end
  redis.call(
    'XADD', KEYS[9], 'MAXLEN', '~', '10000', '*',
    'type', 'retry', 'id', ARGV[1], 'at', ARGV[6]
  )
  return 1
end

redis.call(
  'HSET',
  meta,
  'status', 'failed',
  'finishedAt', ARGV[6]
)
local dedupe = redis.call('HGET', meta, 'key')
local key_retention = tonumber(
  redis.call('HGET', meta, 'keyRetention') or '0'
)
if dedupe and dedupe ~= '' then
  if key_retention > 0 then
    redis.call(
      'HSET',
      meta,
      'keyExpiresAt',
      tostring(tonumber(ARGV[6]) + key_retention)
    )
  else
    redis.call('HDEL', KEYS[6], dedupe)
  end
end
redis.call('LPUSH', KEYS[5], ARGV[1])
redis.call('LTRIM', KEYS[5], 0, tonumber(ARGV[8]) - 1)
redis.call('PEXPIRE', meta, math.max(tonumber(ARGV[7]), key_retention))
redis.call(
  'XADD', KEYS[9], 'MAXLEN', '~', '10000', '*',
  'type', 'failed', 'id', ARGV[1], 'at', ARGV[6]
)
return 1
`;

const CANCEL_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
local state = redis.call('HGET', meta, 'status')
if not state then
  return 0
end
if state == 'succeeded' or state == 'failed' or state == 'cancelled' or state == 'expired' then
  return 0
end

local member = redis.call('HGET', meta, 'member')
redis.call('ZREM', KEYS[2], member)
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[7], ARGV[1])
local concurrency_key = redis.call('HGET', meta, 'concurrencyKey')
if state == 'running' and concurrency_key and concurrency_key ~= '' then
  local active = redis.call('HINCRBY', KEYS[8], concurrency_key, -1)
  if active <= 0 then
    redis.call('HDEL', KEYS[8], concurrency_key)
  end
end
redis.call(
  'HSET',
  meta,
  'status', 'cancelled',
  'finishedAt', ARGV[2],
  'error', ARGV[3]
)
redis.call('HDEL', meta, 'token')
local dedupe = redis.call('HGET', meta, 'key')
local key_retention = tonumber(
  redis.call('HGET', meta, 'keyRetention') or '0'
)
if dedupe and dedupe ~= '' then
  if key_retention > 0 then
    redis.call(
      'HSET',
      meta,
      'keyExpiresAt',
      tostring(tonumber(ARGV[2]) + key_retention)
    )
  else
    redis.call('HDEL', KEYS[6], dedupe)
  end
end
redis.call('LPUSH', KEYS[5], ARGV[1])
redis.call('LTRIM', KEYS[5], 0, tonumber(ARGV[5]) - 1)
redis.call('PEXPIRE', meta, math.max(tonumber(ARGV[4]), key_retention))
redis.call(
  'XADD', KEYS[9], 'MAXLEN', '~', '10000', '*',
  'type', 'cancelled', 'id', ARGV[1], 'at', ARGV[2]
)
return 1
`;

const STATS_SCRIPT = `
return {
  redis.call('ZCARD', KEYS[1]),
  redis.call('ZCARD', KEYS[2]),
  redis.call('ZCARD', KEYS[3]),
  redis.call('LLEN', KEYS[4]),
  redis.call('LLEN', KEYS[5]),
  redis.call('LLEN', KEYS[6]),
  redis.call('LLEN', KEYS[7])
}
`;

const REDRIVE_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
local state = redis.call('HGET', meta, 'status')
if state ~= 'failed' and state ~= 'cancelled' and state ~= 'expired' then
  return 0
end
local sequence = redis.call('INCR', KEYS[2])
local member = string.format('%020d', sequence) .. '|' .. ARGV[1]
local priority = tonumber(redis.call('HGET', meta, 'priority') or '0')
redis.call('LREM', KEYS[4], 0, ARGV[1])
redis.call('LREM', KEYS[5], 0, ARGV[1])
redis.call('LREM', KEYS[6], 0, ARGV[1])
redis.call(
  'HSET',
  meta,
  'status', 'queued',
  'attempt', '0',
  'runAt', ARGV[2],
  'member', member,
  'expiresAt', ''
)
redis.call(
  'HDEL',
  meta,
  'startedAt',
  'finishedAt',
  'output',
  'error',
  'progress',
  'token',
  'keyExpiresAt'
)
redis.call('PERSIST', meta)
redis.call('ZADD', KEYS[3], -priority, member)
redis.call(
  'XADD', KEYS[7], 'MAXLEN', '~', '10000', '*',
  'type', 'added', 'id', ARGV[1], 'at', ARGV[2]
)
return 1
`;

const REMOVE_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
local state = redis.call('HGET', meta, 'status')
if state ~= 'succeeded' and state ~= 'failed' and state ~= 'cancelled' and state ~= 'expired' then
  return 0
end
local dedupe = redis.call('HGET', meta, 'key')
if dedupe and dedupe ~= '' then
  redis.call('HDEL', KEYS[9], dedupe)
end
redis.call('LREM', KEYS[5], 0, ARGV[1])
redis.call('LREM', KEYS[6], 0, ARGV[1])
redis.call('LREM', KEYS[7], 0, ARGV[1])
redis.call('LREM', KEYS[8], 0, ARGV[1])
redis.call('ZREM', KEYS[2], redis.call('HGET', meta, 'member'))
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[10], ARGV[1])
redis.call('ZREM', KEYS[11], ARGV[1])
redis.call('DEL', meta)
return 1
`;

const UPSERT_SCHEDULE_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
local owner = redis.call('HGET', meta, 'jobName')
if owner and owner ~= ARGV[2] then
  return {'conflict', owner}
end
redis.call(
  'HSET',
  meta,
  'id', ARGV[1],
  'jobName', ARGV[2],
  'cron', ARGV[3],
  'timezone', ARGV[4],
  'status', 'active',
  'nextRunAt', ARGV[5],
  'input', ARGV[6],
  'catchUp', ARGV[7],
  'submit', ARGV[8]
)
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
return {'ok', ARGV[1]}
`;

const ADVANCE_SCHEDULE_SCRIPT = `
local meta = KEYS[1] .. ARGV[1]
if redis.call('HGET', meta, 'status') ~= 'active' then
  return 0
end
local current = tonumber(redis.call('HGET', meta, 'nextRunAt') or '0')
if current ~= tonumber(ARGV[2]) then
  return 0
end
redis.call('HSET', meta, 'nextRunAt', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`;

export function redis(
  client: RedisCommandClient,
  options: RedisDriverOptions = {}
): RedisDriver {
  if (
    typeof client.send !== "function" &&
    typeof client.sendCommand !== "function"
  ) {
    throw new TypeError(
      "Redis client must expose send(command, args) or sendCommand(args)"
    );
  }

  const prefix = options.prefix?.trim() || "enqiu";
  const pollInterval = options.pollInterval ?? 100;
  const visibilityTimeout = options.visibilityTimeout ?? 30_000;
  const retention = options.retention ?? 7 * 24 * 60 * 60 * 1000;

  positiveNumber("pollInterval", pollInterval);
  positiveNumber("visibilityTimeout", visibilityTimeout);
  positiveNumber("retention", retention);

  const config: RedisDriverConfig = {
    client,
    prefix,
    pollInterval,
    visibilityTimeout,
    retention,
  };
  return {
    kind: "redis",
    ...config,
    createQueue: (
      handlers: DriverHandlers,
      queueOptions: DriverQueueOptions
    ): QueueDriver => new RedisDriverAdapter(handlers, config, queueOptions),
  };
}

export class RedisQueue<Jobs extends JobMap> {
  readonly name: string;

  private readonly handlers: Jobs;
  private readonly driver: RedisDriverConfig;
  private readonly workerEnabled: boolean;
  private concurrency: number;
  private readonly retry: NormalizedRedisRetry;
  private readonly timeout: number | undefined;
  private readonly rateLimit: RateLimitOptions | undefined;
  private readonly historyLimit: number;
  private readonly logLimit: number;
  private readonly keys: ReturnType<typeof queueKeys>;
  private readonly local = new Map<string, RedisJobRecord>();
  private readonly listeners = new Map<
    keyof RedisQueueEventMap,
    Set<(payload: never) => void>
  >();
  private readonly running = new Set<Promise<void>>();

  private started: boolean;
  private closed = false;
  private workerLoop: Promise<void> | undefined;
  private eventLoop: Promise<void> | undefined;
  private eventCursor: string | undefined;
  private sequence = 0;

  constructor(handlers: Jobs, options: RedisQueueOptions) {
    if (Object.keys(handlers).length === 0) {
      throw new TypeError("At least one job handler is required");
    }

    this.handlers = handlers;
    this.driver = options.driver;
    this.name = options.name?.trim() || "default";
    this.workerEnabled = options.worker ?? true;
    this.concurrency = options.concurrency ?? Number.POSITIVE_INFINITY;
    this.retry = normalizeRetry(options.retry);
    this.timeout = options.timeout;
    this.rateLimit = options.rateLimit;
    this.historyLimit = options.historyLimit ?? 1000;
    this.logLimit = options.logLimit ?? 100;
    this.started = options.autoStart ?? true;
    this.keys = queueKeys(this.driver.prefix, this.name);

    positiveIntegerOrInfinity("concurrency", this.concurrency);
    // The in-memory driver accepts 0 here. Redis trims its terminal lists with
    // LTRIM, which cannot express "retain nothing", so this driver requires at
    // least 1 and says so rather than silently clamping the value.
    positiveInteger("historyLimit", this.historyLimit);
    nonNegativeInteger("logLimit", this.logLimit);
    if (this.timeout !== undefined) {
      positiveNumber("timeout", this.timeout);
    }
    if (this.rateLimit) {
      positiveInteger("rateLimit.limit", this.rateLimit.limit);
      positiveNumber("rateLimit.interval", this.rateLimit.interval);
    }
    if (this.started && this.workerEnabled) {
      this.ensureWorker();
    }
  }

  add<Name extends JobName<Jobs>>(
    name: Name,
    input: JobInput<Jobs, Name>,
    options: RedisAddOptions = {}
  ): RedisJob<JobOutput<Jobs, Name>, JobInput<Jobs, Name>, Name> {
    this.assertOpen();
    if (typeof this.handlers[name] !== "function") {
      throw new TypeError(`Unknown job "${name}"`);
    }

    const now = Date.now();
    const requestedRunAt = resolveRunAt(options.delay, now);
    const resolvedRunAt =
      options.debounce?.mode === "trailing"
        ? Math.max(requestedRunAt, now + options.debounce.wait)
        : requestedRunAt;
    const record: RedisJobRecord = {
      id: options.id ?? createId(this.name, String(name), now, this.nextSequence()),
      name: String(name),
      input,
      status: resolvedRunAt > now ? "scheduled" : "queued",
      priority: options.priority ?? 0,
      attempt: 0,
      retry:
        options.retry === undefined
          ? this.retry
          : normalizeRetry(options.retry),
      timeout: options.timeout ?? this.timeout,
      expiresAt:
        options.expiresIn === undefined
          ? undefined
          : now + options.expiresIn,
      keyRetention: options.keyRetention ?? 0,
      concurrency: options.concurrency,
      throttle: options.throttle,
      debounce: options.debounce,
      createdAt: now,
      runAt: resolvedRunAt,
      startedAt: undefined,
      finishedAt: undefined,
      progress: undefined,
      output: undefined,
      error: undefined,
      logs: [],
      deduplicated: false,
      submission: Promise.resolve(),
      submissionError: undefined,
    };

    if (!record.id) {
      throw new TypeError("Job ID must not be empty");
    }
    if (!Number.isFinite(record.priority)) {
      throw new RangeError("priority must be a finite number");
    }
    if (record.timeout !== undefined) {
      positiveNumber("timeout", record.timeout);
    }
    if (options.expiresIn !== undefined) {
      positiveNumber("expiresIn", options.expiresIn);
    }
    nonNegativeNumber("keyRetention", record.keyRetention);

    record.submission = this.enqueue(record, options.key).catch((cause) => {
      const error = toError(cause);
      record.submissionError = error;
      record.status = "failed";
      record.error = serializeError(error);
      record.finishedAt = Date.now();
      this.emit("error", error);
      throw error;
    });
    // Mark the rejection handled until a consumer reads `accepted` or `result`.
    void record.submission.catch(() => undefined);

    this.local.set(record.id, record);
    return this.handle(record);
  }

  addMany<Name extends JobName<Jobs>>(
    name: Name,
    inputs: readonly JobInput<Jobs, Name>[],
    options?: RedisAddOptions
  ): Array<RedisJob<JobOutput<Jobs, Name>, JobInput<Jobs, Name>, Name>> {
    return inputs.map((input) => this.add(name, input, options));
  }

  async get(id: string): Promise<JobSnapshot | undefined> {
    const values = await this.command("HMGET", [
      this.keys.meta + id,
      "id",
      "name",
      "input",
      "status",
      "priority",
      "attempt",
      "retries",
      "createdAt",
      "runAt",
      "expiresAt",
      "startedAt",
      "finishedAt",
      "progress",
      "output",
      "error",
      "logs",
    ]);
    if (!Array.isArray(values) || values[0] === null) {
      return undefined;
    }
    const result = snapshotFromFields(values);
    const local = this.local.get(id);
    if (local) {
      applySnapshot(local, result);
    }
    return result;
  }

  async list(options: RedisListOptions = {}): Promise<RedisListPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("list.limit must be an integer between 1 and 1000");
    }
    const offset = options.cursor === undefined
      ? 0
      : Number.parseInt(options.cursor, 10);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new TypeError("Invalid list cursor");
    }
    const minimum = options.after === undefined
      ? "-inf"
      : `(${options.after}`;
    const maximum = options.before === undefined
      ? "+inf"
      : `(${options.before}`;
    const scanSize = Math.min(4000, Math.max(limit * 4, limit));
    const raw = await this.command("ZRANGEBYSCORE", [
      this.keys.all,
      minimum,
      maximum,
      "LIMIT",
      String(offset),
      String(scanSize),
    ]);
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    const jobs: JobSnapshot[] = [];
    for (const id of ids) {
      const snapshot = await this.get(id);
      if (!snapshot) {
        await this.command("ZREM", [this.keys.all, id]);
        continue;
      }
      if (
        (options.status && snapshot.status !== options.status) ||
        (options.name && snapshot.name !== options.name)
      ) {
        continue;
      }
      jobs.push(snapshot);
      if (jobs.length >= limit) {
        break;
      }
    }
    const nextOffset = offset + ids.length;
    return ids.length === scanSize
      ? { jobs, cursor: String(nextOffset) }
      : { jobs };
  }

  async cleanup(options: {
    status?: JobStatus | readonly JobStatus[];
    olderThan?: number;
    limit?: number;
  } = {}): Promise<string[]> {
    const olderThan = options.olderThan ?? 0;
    const limit = options.limit ?? 1000;
    nonNegativeNumber("cleanup.olderThan", olderThan);
    if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) {
      throw new RangeError(
        "cleanup.limit must be an integer between 0 and 10000"
      );
    }
    const statuses = new Set(cleanupStatuses(options.status));
    const threshold = Date.now() - olderThan;
    const removed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(
        cursor === undefined ? { limit: 1000 } : { limit: 1000, cursor }
      );
      for (const job of page.jobs) {
        if (
          removed.length >= limit ||
          !statuses.has(job.status) ||
          (job.finishedAt ?? Number.POSITIVE_INFINITY) > threshold
        ) {
          continue;
        }
        const result = await this.eval(
          REMOVE_SCRIPT,
          [
            this.keys.meta,
            this.keys.ready,
            this.keys.delayed,
            this.keys.active,
            this.keys.completed,
            this.keys.failed,
            this.keys.cancelled,
            this.keys.expired,
            this.keys.dedupe,
            this.keys.expiring,
            this.keys.all,
          ],
          [job.id]
        );
        if (Number(result) === 1) {
          this.local.delete(job.id);
          removed.push(job.id);
        }
      }
      cursor = page.cursor;
    } while (cursor && removed.length < limit);
    return removed;
  }

  async redrive(id: string): Promise<RedisJob<unknown>> {
    this.assertOpen();
    const result = await this.eval(
      REDRIVE_SCRIPT,
      [
        this.keys.meta,
        this.keys.sequence,
        this.keys.ready,
        this.keys.failed,
        this.keys.cancelled,
        this.keys.expired,
        this.keys.events,
      ],
      [id, String(Date.now())]
    );
    if (Number(result) !== 1) {
      throw new Error(`Job "${id}" cannot be redriven`);
    }
    const snapshot = await this.get(id);
    if (!snapshot) {
      throw new Error(`Job "${id}" no longer exists`);
    }
    const record = this.recordFromSnapshot(snapshot);
    this.local.set(id, record);
    return this.handle(record);
  }

  async pauseQueue(): Promise<void> {
    await this.command("HSET", [this.keys.config, "paused", "1"]);
  }

  async resumeQueue(): Promise<void> {
    await this.command("HDEL", [this.keys.config, "paused"]);
  }

  async setGlobalConcurrency(limit: number): Promise<void> {
    positiveInteger("global concurrency", limit);
    await this.command("HSET", [
      this.keys.config,
      "concurrency",
      String(limit),
    ]);
  }

  async upsertSchedule(
    registration: RedisScheduleRegistration
  ): Promise<RedisScheduleHandle> {
    this.assertOpen();
    parseCron(registration.cron);
    const timezone = validateTimeZone(registration.timezone ?? "UTC");
    const id = registration.id?.trim() || registration.jobName;
    if (!id) {
      throw new TypeError("schedule.id must not be empty");
    }
    const nextRunAt = nextCronOccurrence(
      registration.cron,
      timezone,
      Date.now()
    );
    const result = await this.eval(
      UPSERT_SCHEDULE_SCRIPT,
      [this.keys.scheduleMeta, this.keys.schedules],
      [
        id,
        registration.jobName,
        registration.cron,
        timezone,
        String(nextRunAt),
        encode(registration.input),
        registration.catchUp ? "1" : "0",
        encode(registration.submit),
      ]
    );
    if (
      !Array.isArray(result) ||
      String(result[0]) !== "ok"
    ) {
      const owner = Array.isArray(result) ? String(result[1]) : "another job";
      throw new Error(
        `Schedule "${id}" already belongs to job "${owner}"`
      );
    }
    return new RedisScheduleHandleImpl(this, id, nextRunAt);
  }

  async getSchedule(
    id: string
  ): Promise<RedisScheduleSnapshot | undefined> {
    const values = await this.command("HMGET", [
      this.keys.scheduleMeta + id,
      "id",
      "jobName",
      "cron",
      "timezone",
      "status",
      "nextRunAt",
      "input",
      "catchUp",
    ]);
    if (!Array.isArray(values) || values[0] === null) {
      return undefined;
    }
    return {
      id: String(values[0]),
      jobName: String(values[1]),
      cron: String(values[2]),
      timezone: String(values[3]),
      status: String(values[4]) as "active" | "paused",
      nextRunAt: Number(values[5]),
      input: decode(String(values[6])),
      catchUp: String(values[7]) === "1",
    };
  }

  async pauseSchedule(id: string): Promise<void> {
    if (!(await this.getSchedule(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.command("HSET", [
      this.keys.scheduleMeta + id,
      "status",
      "paused",
    ]);
    await this.command("ZREM", [this.keys.schedules, id]);
  }

  async resumeSchedule(id: string): Promise<number> {
    const schedule = await this.getSchedule(id);
    if (!schedule) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    const nextRunAt = nextCronOccurrence(
      schedule.cron,
      schedule.timezone,
      Date.now()
    );
    await this.command("HSET", [
      this.keys.scheduleMeta + id,
      "status",
      "active",
      "nextRunAt",
      String(nextRunAt),
    ]);
    await this.command("ZADD", [
      this.keys.schedules,
      String(nextRunAt),
      id,
    ]);
    return nextRunAt;
  }

  async removeSchedule(id: string): Promise<void> {
    if (!(await this.getSchedule(id))) {
      throw new Error(`Schedule "${id}" does not exist`);
    }
    await this.command("ZREM", [this.keys.schedules, id]);
    await this.command("DEL", [this.keys.scheduleMeta + id]);
  }

  async cancel(id: string, reason = "Job was cancelled"): Promise<boolean> {
    const error = serializeError(new JobCancelledError(id, reason));
    const result = await this.eval(
      CANCEL_SCRIPT,
      [
        this.keys.meta,
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.cancelled,
        this.keys.dedupe,
        this.keys.expiring,
        this.keys.activeKeys,
        this.keys.events,
      ],
      [
        id,
        String(Date.now()),
        JSON.stringify(error),
        String(this.driver.retention),
        String(this.historyLimit),
      ]
    );
    const cancelled = Number(result) === 1;
    if (cancelled) {
      const local = this.local.get(id);
      if (local) {
        local.status = "cancelled";
        local.error = error;
        local.finishedAt = Date.now();
      }
    }
    return cancelled;
  }

  async stats(): Promise<QueueStats> {
    const result = await this.eval(
      STATS_SCRIPT,
      [
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.completed,
        this.keys.failed,
        this.keys.cancelled,
        this.keys.expired,
      ],
      []
    );
    const values = Array.isArray(result) ? result.map(Number) : [];
    const stats: QueueStats = {
      queued: values[0] ?? 0,
      scheduled: values[1] ?? 0,
      running: values[2] ?? 0,
      succeeded: values[3] ?? 0,
      failed: values[4] ?? 0,
      cancelled: values[5] ?? 0,
      expired: values[6] ?? 0,
      total: 0,
    };
    stats.total =
      stats.queued +
      stats.scheduled +
      stats.running +
      stats.succeeded +
      stats.failed +
      stats.cancelled +
      stats.expired;
    return stats;
  }

  pause(): this {
    this.assertOpen();
    this.started = false;
    return this;
  }

  start(): this {
    this.assertOpen();
    this.started = true;
    if (this.workerEnabled) {
      this.ensureWorker();
    }
    return this;
  }

  setWorkerConcurrency(limit: number): void {
    positiveIntegerOrInfinity("worker concurrency", limit);
    this.concurrency = limit;
  }

  async onIdle(): Promise<void> {
    while (this.running.size > 0) {
      await sleep(this.driver.pollInterval);
    }
  }

  async close(options: { drain?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.started = false;
    if (options.drain ?? true) {
      await this.onIdle();
    }
    this.closed = true;
    await Promise.allSettled(this.running);
    await this.workerLoop;
    await this.eventLoop;
  }

  on<Event extends keyof RedisQueueEventMap>(
    event: Event,
    listener: (payload: RedisQueueEventMap[Event]) => void
  ): () => void {
    let group = this.listeners.get(event);
    if (!group) {
      group = new Set();
      this.listeners.set(event, group);
    }
    group.add(listener as (payload: never) => void);
    if (event !== "error" && event !== "idle") {
      this.ensureEventLoop();
    }
    return () => {
      group?.delete(listener as (payload: never) => void);
    };
  }

  /** @internal */
  async resultFor(record: RedisJobRecord): Promise<unknown> {
    await record.submission;
    while (true) {
      const current = await this.get(record.id);
      if (!current) {
        throw new Error(`Job "${record.id}" no longer exists`);
      }
      if (current.status === "succeeded") {
        return current.output;
      }
      if (current.status === "failed") {
        throw new JobFailedError(
          record.id,
          current.error?.message ?? `Job "${record.id}" failed`
        );
      }
      if (current.status === "cancelled") {
        throw new JobCancelledError(record.id, current.error?.message);
      }
      if (current.status === "expired") {
        throw new JobExpiredError(record.id);
      }
      await sleep(this.driver.pollInterval);
    }
  }

  /** Monotonic suffix that keeps generated job IDs unique within a process. */
  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private handle<
    Output = unknown,
    Input = unknown,
    Name extends string = string,
  >(record: RedisJobRecord): RedisJob<Output, Input, Name> {
    return new RedisJobHandle<Output, Input, Name>(this, record);
  }

  private async enqueue(
    record: RedisJobRecord,
    key: string | undefined
  ): Promise<void> {
    const result = await this.eval(
      ENQUEUE_SCRIPT,
      [
        this.keys.meta,
        this.keys.sequence,
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.completed,
        this.keys.dedupe,
        this.keys.expiring,
        this.keys.debounce,
        this.keys.debounceExpiry,
        this.keys.events,
        this.keys.all,
      ],
      [
        record.id,
        record.name,
        encode(record.input),
        String(record.priority),
        String(record.runAt),
        String(record.createdAt),
        String(record.retry.retries),
        encode(record.retry.backoff),
        key ? `${record.name}:${key}` : "",
        record.timeout === undefined ? "" : String(record.timeout),
        record.expiresAt === undefined ? "" : String(record.expiresAt),
        String(record.keyRetention),
        record.concurrency?.key ?? "",
        record.concurrency === undefined
          ? ""
          : String(record.concurrency.limit),
        record.throttle?.key ?? "",
        record.throttle === undefined
          ? ""
          : String(record.throttle.limit),
        record.throttle === undefined
          ? ""
          : String(record.throttle.interval),
        record.throttle === undefined
          ? ""
          : String(record.throttle.burst),
        record.debounce
          ? `${record.name}:${record.debounce.key}`
          : "",
        record.debounce === undefined
          ? ""
          : String(record.debounce.wait),
        record.debounce?.mode ?? "",
      ]
    );
    if (!Array.isArray(result)) {
      throw new Error("Redis returned an invalid enqueue response");
    }
    const outcome = String(result[0]);
    const id = String(result[1]);
    if (outcome === "duplicate") {
      throw new Error(`Job ID "${id}" already exists`);
    }
    if (outcome === "deduplicated" || outcome === "debounced") {
      this.local.delete(record.id);
      record.id = id;
      record.deduplicated = true;
      const existing = await this.get(id);
      if (existing) {
        applySnapshot(record, existing);
      }
      this.local.set(id, record);
    }
  }

  private ensureWorker(): void {
    if (this.workerLoop || this.closed || !this.workerEnabled) {
      return;
    }
    this.workerLoop = this.work().finally(() => {
      this.workerLoop = undefined;
    });
  }

  private async work(): Promise<void> {
    while (!this.closed) {
      if (!this.started) {
        await sleep(this.driver.pollInterval);
        continue;
      }
      if (this.running.size >= this.concurrency) {
        await Promise.race(this.running);
        continue;
      }

      try {
        await this.processSchedules();
        const claimed = await this.claim();
        if (!claimed) {
          if (this.running.size > 0) {
            await Promise.race([
              ...this.running,
              sleep(this.driver.pollInterval),
            ]);
          } else {
            await sleep(this.driver.pollInterval);
          }
          continue;
        }

        const execution = this.execute(claimed).finally(() => {
          this.running.delete(execution);
        });
        this.running.add(execution);
      } catch (cause) {
        this.emit("error", toError(cause));
        await sleep(Math.max(1000, this.driver.pollInterval));
      }
    }
  }

  private async claim(): Promise<ClaimedJob | undefined> {
    const token = randomToken();
    const leaseError = serializeError(
      new Error("Worker lease expired before the job completed")
    );
    leaseError.name = "WorkerLeaseExpiredError";
    const result = await this.eval(
      CLAIM_SCRIPT,
      [
        this.keys.meta,
        this.keys.ready,
        this.keys.delayed,
        this.keys.active,
        this.keys.starts,
        this.keys.completed,
        this.keys.failed,
        this.keys.dedupe,
        this.keys.expiring,
        this.keys.expired,
        this.keys.config,
        this.keys.activeKeys,
        this.keys.throttleTokens,
        this.keys.throttleUpdated,
        this.keys.events,
        this.keys.debounce,
        this.keys.debounceExpiry,
      ],
      [
        String(Date.now()),
        token,
        String(this.driver.visibilityTimeout),
        String(this.rateLimit?.limit ?? 0),
        String(this.rateLimit?.interval ?? 0),
        "100",
        JSON.stringify(leaseError),
        String(this.driver.retention),
        String(this.historyLimit),
        JSON.stringify({
          name: "JobExpiredError",
          message: "Job expired before it could start",
        }),
      ]
    );
    if (!Array.isArray(result) || result[0] !== "job") {
      return undefined;
    }
    return {
      id: String(result[1]),
      name: String(result[2]),
      input: decode(String(result[3])),
      attempt: Number(result[4]),
      retry: {
        retries: Number(result[5]),
        backoff: decode(String(result[6])) as
          | number
          | BackoffOptions
          | undefined,
      },
      timeout:
        result[7] === "" || result[7] === null
          ? undefined
          : Number(result[7]),
      token,
    };
  }

  private async processSchedules(): Promise<void> {
    const now = Date.now();
    const raw = await this.command("ZRANGEBYSCORE", [
      this.keys.schedules,
      "-inf",
      String(now),
      "LIMIT",
      "0",
      "20",
    ]);
    const ids = Array.isArray(raw) ? raw.map(String) : [];
    for (const id of ids) {
      const values = await this.command("HMGET", [
        this.keys.scheduleMeta + id,
        "jobName",
        "cron",
        "timezone",
        "status",
        "nextRunAt",
        "input",
        "catchUp",
        "submit",
      ]);
      if (!Array.isArray(values) || values[0] === null) {
        await this.command("ZREM", [this.keys.schedules, id]);
        continue;
      }
      if (String(values[3]) !== "active") {
        await this.command("ZREM", [this.keys.schedules, id]);
        continue;
      }

      const jobName = String(values[0]);
      const cron = String(values[1]);
      const timezone = String(values[2]);
      const occurrence = Number(values[4]);
      const input = decode(String(values[5]));
      const catchUp = String(values[6]) === "1";
      const submit = decode(String(values[7])) as RedisAddOptions;
      const nextRunAt = nextCronOccurrence(
        cron,
        timezone,
        catchUp ? occurrence : now
      );
      const occurrenceId = `${this.name}:schedule:${id}:${occurrence}`;

      let accepted = false;
      try {
        const handle = this.add(jobName as JobName<Jobs>, input as never, {
          ...submit,
          id: occurrenceId,
        });
        await handle.accepted;
        accepted = true;
      } catch (cause) {
        const error = toError(cause);
        if (error.message.includes(`Job ID "${occurrenceId}" already exists`)) {
          accepted = true;
        } else {
          this.emit("error", error);
        }
      }
      if (!accepted) {
        continue;
      }
      await this.eval(
        ADVANCE_SCHEDULE_SCRIPT,
        [this.keys.scheduleMeta, this.keys.schedules],
        [id, String(occurrence), String(nextRunAt)]
      );
    }
  }

  private async execute(claimed: ClaimedJob): Promise<void> {
    const handler = this.handlers[claimed.name as JobName<Jobs>];
    if (typeof handler !== "function") {
      await this.fail(
        claimed,
        new Error(`No handler registered for job "${claimed.name}"`),
        false,
        0
      );
      return;
    }

    const local =
      this.local.get(claimed.id) ??
      this.localRecordFromClaim(claimed);
    local.status = "running";
    local.attempt = claimed.attempt;
    local.startedAt = Date.now();

    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.heartbeat(claimed, controller);
    }, Math.max(100, Math.floor(this.driver.visibilityTimeout / 3)));

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const context: JobContext = {
        id: claimed.id,
        name: claimed.name,
        attempt: claimed.attempt,
        signal: controller.signal,
        progress: (value: unknown): void => {
          local.progress = value;
          void this.command("HSET", [
            this.keys.meta + claimed.id,
            "progress",
            encode(value),
          ])
            .then(() => this.publishEvent("progress", claimed.id))
            .catch((cause) => this.emit("error", toError(cause)));
        },
        log: (entry: JobLogEntry): void => {
          if (this.logLimit === 0) {
            return;
          }
          local.logs.push(entry);
          if (local.logs.length > this.logLimit) {
            local.logs.splice(0, local.logs.length - this.logLimit);
          }
          void this.command("HSET", [
            this.keys.meta + claimed.id,
            "logs",
            encode(local.logs),
          ])
            .then(() => this.publishEvent("log", claimed.id))
            .catch((cause) => this.emit("error", toError(cause)));
        },
      };
      const execution = Promise.resolve(handler(claimed.input, context));
      const output =
        claimed.timeout === undefined
          ? await execution
          : await Promise.race([
              execution,
              new Promise<never>((_, reject) => {
                timeoutTimer = setTimeout(() => {
                  const error = new JobTimeoutError(
                    claimed.id,
                    claimed.timeout as number
                  );
                  controller.abort(error);
                  reject(error);
                }, claimed.timeout);
              }),
            ]);

      const completed = await this.complete(claimed, output);
      if (completed) {
        local.status = "succeeded";
        local.output = output;
        local.finishedAt = Date.now();
      }
    } catch (cause) {
      const error = toError(cause);
      const retry =
        claimed.attempt <= claimed.retry.retries;
      const delay = retry
        ? retryDelay(claimed.retry.backoff, claimed.attempt)
        : 0;
      const failed = await this.fail(claimed, error, retry, delay);
      if (failed) {
        local.error = serializeError(error);
        if (retry) {
          local.status = delay > 0 ? "scheduled" : "queued";
          local.runAt = Date.now() + delay;
        } else {
          local.status = "failed";
          local.finishedAt = Date.now();
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    }
  }

  private async heartbeat(
    job: ClaimedJob,
    controller: AbortController
  ): Promise<void> {
    try {
      const result = await this.eval(
        HEARTBEAT_SCRIPT,
        [this.keys.meta, this.keys.active],
        [
          job.id,
          job.token,
          String(Date.now() + this.driver.visibilityTimeout),
        ]
      );
      if (Number(result) !== 1 && !controller.signal.aborted) {
        controller.abort(new JobCancelledError(job.id, "Job ownership lost"));
      }
    } catch (cause) {
      this.emit("error", toError(cause));
    }
  }

  private async complete(job: ClaimedJob, output: unknown): Promise<boolean> {
    const result = await this.eval(
      COMPLETE_SCRIPT,
      [
        this.keys.meta,
        this.keys.active,
        this.keys.completed,
        this.keys.dedupe,
        this.keys.activeKeys,
        this.keys.events,
      ],
      [
        job.id,
        job.token,
        String(Date.now()),
        encode(output),
        String(this.driver.retention),
        String(this.historyLimit),
      ]
    );
    return Number(result) === 1;
  }

  private async fail(
    job: ClaimedJob,
    error: Error,
    retry: boolean,
    delay: number
  ): Promise<boolean> {
    const now = Date.now();
    const result = await this.eval(
      FAIL_SCRIPT,
      [
        this.keys.meta,
        this.keys.active,
        this.keys.ready,
        this.keys.delayed,
        this.keys.failed,
        this.keys.dedupe,
        this.keys.activeKeys,
        this.keys.expiring,
        this.keys.events,
      ],
      [
        job.id,
        job.token,
        retry ? "1" : "0",
        JSON.stringify(serializeError(error)),
        String(now + delay),
        String(now),
        String(this.driver.retention),
        String(this.historyLimit),
      ]
    );
    return Number(result) === 1;
  }

  private localRecordFromClaim(claimed: ClaimedJob): RedisJobRecord {
    const now = Date.now();
    const record: RedisJobRecord = {
      id: claimed.id,
      name: claimed.name,
      input: claimed.input,
      status: "running",
      priority: 0,
      attempt: claimed.attempt,
      retry: claimed.retry,
      timeout: claimed.timeout,
      expiresAt: undefined,
      keyRetention: 0,
      concurrency: undefined,
      throttle: undefined,
      debounce: undefined,
      createdAt: now,
      runAt: now,
      startedAt: now,
      finishedAt: undefined,
      progress: undefined,
      output: undefined,
      error: undefined,
      logs: [],
      deduplicated: false,
      submission: Promise.resolve(),
      submissionError: undefined,
    };
    this.local.set(record.id, record);
    return record;
  }

  private recordFromSnapshot(snapshot: JobSnapshot): RedisJobRecord {
    return {
      id: snapshot.id,
      name: snapshot.name,
      input: snapshot.input,
      status: snapshot.status,
      priority: snapshot.priority,
      attempt: snapshot.attempt,
      retry: {
        retries: snapshot.retries,
        backoff: undefined,
      },
      timeout: undefined,
      expiresAt: snapshot.expiresAt,
      keyRetention: 0,
      concurrency: undefined,
      throttle: undefined,
      debounce: undefined,
      createdAt: snapshot.createdAt,
      runAt: snapshot.runAt,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      progress: snapshot.progress,
      output: snapshot.output,
      error: snapshot.error,
      logs: [...(snapshot.logs ?? [])],
      deduplicated: false,
      submission: Promise.resolve(),
      submissionError: undefined,
    };
  }

  private ensureEventLoop(): void {
    if (this.eventLoop || this.closed) {
      return;
    }
    this.eventLoop = this.readEvents().finally(() => {
      this.eventLoop = undefined;
    });
  }

  private async readEvents(): Promise<void> {
    if (this.eventCursor === undefined) {
      const latest = await this.command("XREVRANGE", [
        this.keys.events,
        "+",
        "-",
        "COUNT",
        "1",
      ]);
      this.eventCursor = firstStreamEntryId(latest) ?? "0-0";
    }
    while (!this.closed && this.hasEventListeners()) {
      try {
        const result = await this.command("XREAD", [
          "COUNT",
          "100",
          "STREAMS",
          this.keys.events,
          this.eventCursor,
        ]);
        const entries = streamEntries(result);
        for (const entry of entries) {
          this.eventCursor = entry.id;
          await this.dispatchRemoteEvent(entry.fields);
        }
      } catch (cause) {
        this.emit("error", toError(cause));
      }
      await sleep(this.driver.pollInterval);
    }
  }

  private hasEventListeners(): boolean {
    for (const [event, listeners] of this.listeners) {
      if (event !== "error" && event !== "idle" && listeners.size > 0) {
        return true;
      }
    }
    return false;
  }

  private async dispatchRemoteEvent(
    fields: ReadonlyMap<string, string>
  ): Promise<void> {
    const type = fields.get("type") as keyof RedisQueueEventMap | undefined;
    const id = fields.get("id");
    if (!type || !id || type === "error" || type === "idle") {
      return;
    }
    const value = await this.get(id);
    if (!value) {
      return;
    }
    const at = Number(fields.get("at") ?? Date.now());
    const snapshot = snapshotForEvent(type, value, at);
    if (type === "retry") {
      const error = errorFromSerialized(snapshot.error);
      this.emit("retry", {
        job: snapshot,
        error,
        delay: Math.max(0, snapshot.runAt - at),
      });
      return;
    }
    if (type === "log") {
      const entry = snapshot.logs?.at(-1);
      if (entry) {
        this.emit("log", { job: snapshot, entry });
      }
      return;
    }
    if (type === "recovered") {
      this.emit("recovered", snapshot);
      return;
    }
    this.emit(
      type as Exclude<
        keyof RedisQueueEventMap,
        "error" | "idle" | "retry" | "log" | "recovered"
      >,
      snapshot
    );
  }

  private async publishEvent(type: string, id: string): Promise<void> {
    await this.command("XADD", [
      this.keys.events,
      "MAXLEN",
      "~",
      "10000",
      "*",
      "type",
      type,
      "id",
      id,
      "at",
      String(Date.now()),
    ]);
  }

  private async command(
    command: string,
    arguments_: string[]
  ): Promise<unknown> {
    if (this.driver.client.send) {
      return this.driver.client.send(command, arguments_);
    }
    if (this.driver.client.sendCommand) {
      return this.driver.client.sendCommand([command, ...arguments_]);
    }
    throw new TypeError("Invalid Redis command client");
  }

  private eval(
    script: string,
    keys: string[],
    arguments_: string[]
  ): Promise<unknown> {
    return this.command("EVAL", [
      script,
      String(keys.length),
      ...keys,
      ...arguments_,
    ]);
  }

  private emit<Event extends keyof RedisQueueEventMap>(
    event: Event,
    payload: RedisQueueEventMap[Event]
  ): void {
    const group = this.listeners.get(event);
    if (!group) {
      return;
    }
    for (const listener of group) {
      try {
        listener(payload as never);
      } catch {
        // Observers cannot interrupt queue processing.
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new QueueClosedError(this.name);
    }
  }
}

class RedisJobHandle<Output, Input, Name extends string>
  implements RedisJob<Output, Input, Name>
{
  constructor(
    private readonly owner: RedisQueue<JobMap>,
    private readonly record: RedisJobRecord
  ) {}

  get id(): string {
    return this.record.id;
  }

  get name(): Name {
    return this.record.name as Name;
  }

  get input(): Input {
    return this.record.input as Input;
  }

  get status(): JobStatus {
    return this.record.status;
  }

  get deduplicated(): boolean {
    return this.record.deduplicated;
  }

  get accepted(): Promise<void> {
    return this.record.submission;
  }

  get result(): Promise<Output> {
    return this.owner.resultFor(this.record) as Promise<Output>;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.owner.cancel(this.id, reason);
  }

  async refresh(): Promise<JobSnapshot<Input, Output, Name>> {
    await this.accepted;
    const value = await this.owner.get(this.id);
    if (!value) {
      throw new Error(`Job "${this.id}" no longer exists`);
    }
    return value as JobSnapshot<Input, Output, Name>;
  }

}

/** Presents a Redis job through the driver contract. */
class RedisDriverJob implements DriverJob {
  constructor(private readonly job: RedisJob) {}

  get id(): string {
    return this.job.id;
  }

  get name(): string {
    return this.job.name;
  }

  get input(): unknown {
    return this.job.input;
  }

  get status(): JobStatus {
    return this.job.status;
  }

  get deduplicated(): boolean {
    return this.job.deduplicated;
  }

  get accepted(): Promise<void> {
    return this.job.accepted;
  }

  get result(): Promise<unknown> {
    return this.job.result;
  }

  cancel(reason?: string): Promise<boolean> {
    return this.job.cancel(reason);
  }

  snapshot(): Promise<JobSnapshot> {
    return this.job.refresh();
  }
}

class RedisDriverAdapter implements QueueDriver {
  private readonly queue: RedisQueue<DriverHandlers>;

  constructor(
    handlers: DriverHandlers,
    config: RedisDriverConfig,
    options: DriverQueueOptions
  ) {
    this.queue = new RedisQueue(
      handlers,
      compact({
        driver: config,
        name: options.name,
        worker: options.worker,
        concurrency: options.concurrency,
        autoStart: options.autoStart,
        // `when` predicates cannot cross a process boundary, so the Redis
        // driver accepts only the serializable part of a retry policy.
        retry: options.retry as RedisQueueOptions["retry"],
        timeout: options.timeout,
        historyLimit: options.historyLimit,
        logLimit: options.logLimit,
      })
    );
  }

  add(name: string, input: unknown, options: AddOptions): DriverJob {
    return new RedisDriverJob(
      this.queue.add(name, input, options as RedisAddOptions)
    );
  }

  get(id: string): Promise<JobSnapshot | undefined> {
    return this.queue.get(id);
  }

  list(query: DriverListQuery): Promise<DriverListPage> {
    return this.queue.list(query);
  }

  stats(): Promise<QueueStats> {
    return this.queue.stats();
  }

  async redrive(id: string): Promise<DriverJob> {
    return new RedisDriverJob(await this.queue.redrive(id));
  }

  cleanup(query: DriverCleanupQuery): Promise<string[]> {
    return this.queue.cleanup(query);
  }

  upsertSchedule(
    registration: DriverScheduleRegistration
  ): Promise<ScheduleHandle> {
    return this.queue.upsertSchedule({
      ...registration,
      submit: registration.submit as RedisAddOptions,
    });
  }

  pauseQueue(): Promise<void> {
    return this.queue.pauseQueue();
  }

  resumeQueue(): Promise<void> {
    return this.queue.resumeQueue();
  }

  setQueueConcurrency(limit: number): Promise<void> {
    return this.queue.setGlobalConcurrency(limit);
  }

  async startWorker(concurrency?: number): Promise<void> {
    if (concurrency !== undefined) {
      this.queue.setWorkerConcurrency(concurrency);
    }
    this.queue.start();
  }

  async pauseWorker(): Promise<void> {
    this.queue.pause();
  }

  onIdle(): Promise<void> {
    return this.queue.onIdle();
  }

  close(options?: { drain?: boolean }): Promise<void> {
    return this.queue.close(options);
  }

  on<Event extends keyof QueueEventMap>(
    event: Event,
    listener: (payload: QueueEventMap[Event]) => void
  ): () => void {
    return this.queue.on(event, listener);
  }
}

class RedisScheduleHandleImpl implements RedisScheduleHandle {
  private cachedNextRunAt: number;

  constructor(
    private readonly owner: RedisQueue<JobMap>,
    readonly id: string,
    nextRunAt: number
  ) {
    this.cachedNextRunAt = nextRunAt;
  }

  get nextRunAt(): number {
    return this.cachedNextRunAt;
  }

  async pause(): Promise<void> {
    await this.owner.pauseSchedule(this.id);
  }

  async resume(): Promise<void> {
    this.cachedNextRunAt = await this.owner.resumeSchedule(this.id);
  }

  async remove(): Promise<void> {
    await this.owner.removeSchedule(this.id);
  }

  async refresh(): Promise<RedisScheduleSnapshot> {
    const value = await this.owner.getSchedule(this.id);
    if (!value) {
      throw new Error(`Schedule "${this.id}" does not exist`);
    }
    this.cachedNextRunAt = value.nextRunAt;
    return value;
  }
}

function queueKeys(prefix: string, name: string) {
  const base = `${prefix}:{${name}}`;
  return {
    meta: `${base}:job:`,
    sequence: `${base}:sequence`,
    ready: `${base}:ready`,
    delayed: `${base}:delayed`,
    active: `${base}:active`,
    starts: `${base}:starts`,
    completed: `${base}:completed`,
    failed: `${base}:failed`,
    cancelled: `${base}:cancelled`,
    expired: `${base}:expired`,
    dedupe: `${base}:dedupe`,
    expiring: `${base}:expiring`,
    activeKeys: `${base}:active-keys`,
    throttleTokens: `${base}:throttle-tokens`,
    throttleUpdated: `${base}:throttle-updated`,
    debounce: `${base}:debounce`,
    debounceExpiry: `${base}:debounce-expiry`,
    config: `${base}:config`,
    events: `${base}:events`,
    all: `${base}:all`,
    scheduleMeta: `${base}:schedule:`,
    schedules: `${base}:schedules`,
  } as const;
}

/** Cleanup defaults to every terminal status when the caller names none. */
function cleanupStatuses(
  status: JobStatus | readonly JobStatus[] | undefined
): readonly JobStatus[] {
  if (status === undefined) {
    return ["succeeded", "failed", "cancelled", "expired"];
  }
  // JobStatus is a string union, so typeof narrows where Array.isArray does
  // not narrow the readonly-array side of the union.
  return typeof status === "string" ? [status] : status;
}

function normalizeRetry(
  retry: number | RedisRetryOptions | undefined
): NormalizedRedisRetry {
  if (retry === undefined) {
    return { retries: 0, backoff: undefined };
  }
  if (typeof retry === "number") {
    nonNegativeInteger("retry", retry);
    return { retries: retry, backoff: undefined };
  }
  nonNegativeInteger("retry.retries", retry.retries);
  if (typeof retry.backoff === "number" && retry.backoff < 0) {
    throw new RangeError("retry.backoff must not be negative");
  }
  return { retries: retry.retries, backoff: retry.backoff };
}

function retryDelay(
  backoff: NormalizedRedisRetry["backoff"],
  attempt: number
): number {
  if (backoff === undefined) {
    return 0;
  }
  if (typeof backoff === "number") {
    nonNegativeNumber("backoff delay", backoff);
    return backoff;
  }
  return backoffFromOptions(backoff, attempt);
}

function snapshotFromFields(values: unknown[]): JobSnapshot {
  const text = (index: number): string =>
    values[index] === null || values[index] === undefined
      ? ""
      : String(values[index]);
  return {
    id: text(0),
    name: text(1),
    input: decode(text(2)),
    status: text(3) as JobStatus,
    priority: Number(text(4)),
    attempt: Number(text(5)),
    retries: Number(text(6)),
    createdAt: Number(text(7)),
    runAt: Number(text(8)),
    expiresAt: optionalNumber(text(9)),
    startedAt: optionalNumber(text(10)),
    finishedAt: optionalNumber(text(11)),
    progress: text(12) ? decode(text(12)) : undefined,
    output: text(13) ? decode(text(13)) : undefined,
    error: text(14)
      ? (JSON.parse(text(14)) as SerializedError)
      : undefined,
    logs: text(15)
      ? (decode(text(15)) as JobLogEntry[])
      : [],
  };
}

function applySnapshot(
  record: RedisJobRecord,
  value: JobSnapshot
): void {
  record.id = value.id;
  record.name = value.name;
  record.input = value.input;
  record.status = value.status;
  record.priority = value.priority;
  record.attempt = value.attempt;
  record.createdAt = value.createdAt;
  record.runAt = value.runAt;
  record.expiresAt = value.expiresAt;
  record.startedAt = value.startedAt;
  record.finishedAt = value.finishedAt;
  record.progress = value.progress;
  record.output = value.output;
  record.error = value.error;
  record.logs = [...(value.logs ?? [])];
}

function createId(
  queue: string,
  name: string,
  now: number,
  sequence: number
): string {
  return `${queue}:${name}:${now.toString(36)}:${sequence.toString(36)}:${randomToken()}`;
}

function randomToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return uuid;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function optionalNumber(value: string): number | undefined {
  return value ? Number(value) : undefined;
}

interface StreamEntry {
  id: string;
  fields: ReadonlyMap<string, string>;
}

function firstStreamEntryId(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (
    typeof value[0] === "string" &&
    /^\d+-\d+$/.test(value[0])
  ) {
    return value[0];
  }
  for (const entry of value) {
    const id = firstStreamEntryId(entry);
    if (id) {
      return id;
    }
  }
  return undefined;
}

function streamEntries(value: unknown): StreamEntry[] {
  const entries: StreamEntry[] = [];
  visitStreamValue(value, entries);
  return entries;
}

function visitStreamValue(value: unknown, entries: StreamEntry[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  if (
    typeof value[0] === "string" &&
    /^\d+-\d+$/.test(value[0]) &&
    Array.isArray(value[1])
  ) {
    const fields = new Map<string, string>();
    const rawFields = value[1];
    for (let index = 0; index < rawFields.length; index += 2) {
      const key = rawFields[index];
      const fieldValue = rawFields[index + 1];
      if (key !== undefined && fieldValue !== undefined) {
        fields.set(String(key), String(fieldValue));
      }
    }
    entries.push({ id: value[0], fields });
    return;
  }
  for (const entry of value) {
    visitStreamValue(entry, entries);
  }
}

function snapshotForEvent(
  type: keyof RedisQueueEventMap,
  snapshot: JobSnapshot,
  timestamp: number
): JobSnapshot {
  if (type === "added") {
    return {
      ...snapshot,
      status: snapshot.runAt > timestamp ? "scheduled" : "queued",
    };
  }
  if (type === "started") {
    return { ...snapshot, status: "running", startedAt: timestamp };
  }
  if (type === "retry" || type === "recovered") {
    return {
      ...snapshot,
      status: snapshot.runAt > timestamp ? "scheduled" : "queued",
    };
  }
  if (
    type === "succeeded" ||
    type === "failed" ||
    type === "cancelled" ||
    type === "expired"
  ) {
    return { ...snapshot, status: type, finishedAt: timestamp };
  }
  return snapshot;
}

