/**
 * Lua for the Redis driver.
 *
 * Every script is atomic on the server, which is what lets a queue coordinate
 * across processes without a lock. They live here rather than inline so the
 * driver reads as TypeScript; KEYS and ARGV positions are documented at each
 * call site in queue.ts.
 */

export const ENQUEUE_SCRIPT = `
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


export const CLAIM_SCRIPT = `
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
    if history_limit > 0 then
      redis.call('LTRIM', KEYS[10], 0, history_limit - 1)
    else
      redis.call('DEL', KEYS[10])
    end
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
      if history_limit > 0 then
        redis.call('LTRIM', KEYS[7], 0, history_limit - 1)
      else
        redis.call('DEL', KEYS[7])
      end
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


export const HEARTBEAT_SCRIPT = `
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


export const COMPLETE_SCRIPT = `
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
local history_limit = tonumber(ARGV[6])
if history_limit > 0 then
  redis.call('LTRIM', KEYS[3], 0, history_limit - 1)
else
  redis.call('DEL', KEYS[3])
end
redis.call('PEXPIRE', meta, math.max(tonumber(ARGV[5]), key_retention))
redis.call(
  'XADD', KEYS[6], 'MAXLEN', '~', '10000', '*',
  'type', 'succeeded', 'id', ARGV[1], 'at', ARGV[3]
)
return 1
`;


export const FAIL_SCRIPT = `
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
local history_limit = tonumber(ARGV[8])
if history_limit > 0 then
  redis.call('LTRIM', KEYS[5], 0, history_limit - 1)
else
  redis.call('DEL', KEYS[5])
end
redis.call('PEXPIRE', meta, math.max(tonumber(ARGV[7]), key_retention))
redis.call(
  'XADD', KEYS[9], 'MAXLEN', '~', '10000', '*',
  'type', 'failed', 'id', ARGV[1], 'at', ARGV[6]
)
return 1
`;


export const CANCEL_SCRIPT = `
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
local history_limit = tonumber(ARGV[5])
if history_limit > 0 then
  redis.call('LTRIM', KEYS[5], 0, history_limit - 1)
else
  redis.call('DEL', KEYS[5])
end
redis.call('PEXPIRE', meta, math.max(tonumber(ARGV[4]), key_retention))
redis.call(
  'XADD', KEYS[9], 'MAXLEN', '~', '10000', '*',
  'type', 'cancelled', 'id', ARGV[1], 'at', ARGV[2]
)
return 1
`;


export const STATS_SCRIPT = `
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


export const REDRIVE_SCRIPT = `
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


export const REMOVE_SCRIPT = `
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


export const UPSERT_SCHEDULE_SCRIPT = `
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


export const ADVANCE_SCHEDULE_SCRIPT = `
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
