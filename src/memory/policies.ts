/**
 * Admission control: whether a ready job may start right now.
 *
 * Two independent gates, both keyed by a string the caller derives from the
 * job's input. Keyed concurrency counts what is running; throttling is a token
 * bucket that refills continuously, so `burst` sets how much idle capacity can
 * be banked and `limit / interval` sets the steady rate.
 *
 * Refusing a job for throttling records when it could next run, which the
 * queue reads to schedule a wake-up rather than busy-polling.
 */

import type { KeyedConcurrencyOptions, ThrottleOptions } from "./types.js";

interface ThrottleState {
  tokens: number;
  updatedAt: number;
}

/** The only part of a job these gates look at. */
export interface PolicyBearingJob {
  concurrency: KeyedConcurrencyOptions | undefined;
  throttle: ThrottleOptions | undefined;
}

export class ExecutionPolicies {
  private readonly activeKeys = new Map<string, number>();
  private readonly throttleStates = new Map<string, ThrottleState>();
  private wakeAt: number | undefined;

  /** Earliest moment a throttled job refused this pass could become runnable. */
  get nextWakeAt(): number | undefined {
    return this.wakeAt;
  }

  /** Called once per pump, before any canStart in that pass. */
  clearWake(): void {
    this.wakeAt = undefined;
  }

  canStart(job: PolicyBearingJob, now: number): boolean {
    if (job.concurrency) {
      const active = this.activeKeys.get(job.concurrency.key) ?? 0;
      if (active >= job.concurrency.limit) {
        return false;
      }
    }
    if (job.throttle) {
      const state = this.refill(job.throttle, now);
      if (state.tokens < 1) {
        const refillPerMs = job.throttle.limit / job.throttle.interval;
        const wakeAt = now + Math.ceil((1 - state.tokens) / refillPerMs);
        this.wakeAt =
          this.wakeAt === undefined ? wakeAt : Math.min(this.wakeAt, wakeAt);
        return false;
      }
    }
    return true;
  }

  /** Claims capacity for a job that is about to run. */
  begin(job: PolicyBearingJob, now: number): void {
    if (job.concurrency) {
      this.activeKeys.set(
        job.concurrency.key,
        (this.activeKeys.get(job.concurrency.key) ?? 0) + 1
      );
    }
    if (job.throttle) {
      const state = this.refill(job.throttle, now);
      state.tokens = Math.max(0, state.tokens - 1);
    }
  }

  /**
   * Returns concurrency capacity once a job settles. Throttle tokens are not
   * returned: the bucket meters starts over time, not simultaneous work.
   */
  release(job: PolicyBearingJob): void {
    if (!job.concurrency) {
      return;
    }
    const active = (this.activeKeys.get(job.concurrency.key) ?? 1) - 1;
    if (active <= 0) {
      this.activeKeys.delete(job.concurrency.key);
    } else {
      this.activeKeys.set(job.concurrency.key, active);
    }
  }

  private refill(policy: ThrottleOptions, now: number): ThrottleState {
    let state = this.throttleStates.get(policy.key);
    if (!state) {
      state = { tokens: policy.burst, updatedAt: now };
      this.throttleStates.set(policy.key, state);
      return state;
    }
    const elapsed = Math.max(0, now - state.updatedAt);
    state.tokens = Math.min(
      policy.burst,
      state.tokens + elapsed * (policy.limit / policy.interval)
    );
    state.updatedAt = now;
    return state;
  }
}
