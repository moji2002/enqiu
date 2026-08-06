/** Delay and backoff arithmetic shared by every driver. */

import { nonNegativeNumber } from "./validate.js";

export interface BackoffOptions {
  type?: "fixed" | "exponential";
  delay: number;
  /**
   * Randomize each delay by up to this fraction.
   * `1` is full jitter; `0.2` produces a value between 80–100%.
   */
  jitter?: number;
}

/**
 * Fixed or exponential growth with optional jitter.
 *
 * Exponential growth overflows to `Infinity` after roughly 1,000 attempts.
 * The guard rejects that rather than handing it to `setTimeout`.
 */
export function backoffFromOptions(
  options: BackoffOptions,
  attempt: number
): number {
  const base =
    options.type === "exponential"
      ? options.delay * 2 ** Math.max(0, attempt - 1)
      : options.delay;
  const jitter = Math.min(1, Math.max(0, options.jitter ?? 0));
  const delay = base * (1 - Math.random() * jitter);
  nonNegativeNumber("backoff delay", delay);
  return delay;
}

/** Resolve a relative delay or absolute date into an epoch timestamp. */
export function resolveRunAt(
  delay: number | Date | undefined,
  now: number
): number {
  if (delay instanceof Date) {
    const value = delay.getTime();
    if (!Number.isFinite(value)) {
      throw new RangeError("delay date must be valid");
    }
    return Math.max(now, value);
  }
  if (delay === undefined) {
    return now;
  }
  nonNegativeNumber("delay", delay);
  return now + delay;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
