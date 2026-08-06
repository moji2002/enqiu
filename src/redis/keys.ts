/**
 * Every key a queue owns, derived from one namespace.
 *
 * The `{name}` braces are a Redis Cluster hash tag: they force all of a
 * queue's keys onto one slot, which the multi-key Lua scripts require.
 */

export function queueKeys(prefix: string, name: string) {
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
