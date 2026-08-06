import { describe, expect, it, vi } from "vitest";
import {
  errorFromSerialized,
  serializeError,
  toError,
} from "../src/internal/errors.js";
import {
  backoffFromOptions,
  resolveRunAt,
  sleep,
} from "../src/internal/timing.js";
import { compact } from "../src/internal/object.js";
import {
  nonEmptyString,
  nonNegativeInteger,
  nonNegativeIntegerOrInfinity,
  nonNegativeNumber,
  positiveInteger,
  positiveIntegerOrInfinity,
  positiveNumber,
} from "../src/internal/validate.js";

describe("internal/validate", () => {
  it("names the offending option in every message", () => {
    expect(() => positiveNumber("timeout", 0)).toThrow(
      "timeout must be a positive finite number"
    );
    expect(() => nonNegativeNumber("olderThan", -1)).toThrow(
      "olderThan must be a non-negative finite number"
    );
    expect(() => positiveInteger("rateLimit.limit", 0)).toThrow(
      "rateLimit.limit must be a positive integer"
    );
    expect(() => nonNegativeInteger("logLimit", -1)).toThrow(
      "logLimit must be a non-negative integer"
    );
    expect(() => nonEmptyString("debounce.key", "   ")).toThrow(
      "debounce.key must not be empty"
    );
  });

  it("rejects non-finite values everywhere a number is expected", () => {
    expect(() => positiveNumber("timeout", Number.NaN)).toThrow(RangeError);
    expect(() => positiveNumber("timeout", Number.POSITIVE_INFINITY)).toThrow(
      RangeError
    );
    expect(() => nonNegativeNumber("delay", Number.NaN)).toThrow(RangeError);
    expect(() => positiveInteger("limit", 1.5)).toThrow(RangeError);
    expect(() => nonNegativeInteger("limit", 1.5)).toThrow(RangeError);
  });

  it("accepts Infinity only for the OrInfinity variants", () => {
    expect(() =>
      positiveIntegerOrInfinity("concurrency", Number.POSITIVE_INFINITY)
    ).not.toThrow();
    expect(() =>
      nonNegativeIntegerOrInfinity("limit", Number.POSITIVE_INFINITY)
    ).not.toThrow();

    expect(() => positiveIntegerOrInfinity("concurrency", 0)).toThrow(
      "concurrency must be a positive integer or Infinity"
    );
    expect(() => nonNegativeIntegerOrInfinity("limit", -1)).toThrow(
      "limit must be a non-negative integer or Infinity"
    );
    expect(() => positiveIntegerOrInfinity("concurrency", 2)).not.toThrow();
    expect(() => nonNegativeIntegerOrInfinity("limit", 0)).not.toThrow();
  });

  it("rejects a non-string where a key is expected", () => {
    expect(() => nonEmptyString("key", undefined as unknown as string)).toThrow(
      TypeError
    );
  });
});

describe("internal/errors", () => {
  it("carries name, message and stack across serialization", () => {
    const original = new RangeError("out of range");
    const serialized = serializeError(original);
    expect(serialized.name).toBe("RangeError");
    expect(serialized.message).toBe("out of range");
    expect(serialized.stack).toBe(original.stack);

    const restored = errorFromSerialized(serialized);
    expect(restored.name).toBe("RangeError");
    expect(restored.message).toBe("out of range");
    expect(restored.stack).toBe(original.stack);
  });

  it("falls back to a usable error when nothing was stored", () => {
    const restored = errorFromSerialized(undefined);
    expect(restored.name).toBe("Error");
    expect(restored.message).toBe("Job attempt failed");
  });

  it("leaves a stack unset when the serialized form had none", () => {
    const restored = errorFromSerialized({ name: "X", message: "y" });
    expect(restored.name).toBe("X");
    expect(restored.message).toBe("y");
  });

  it("wraps a non-Error throw without losing its text", () => {
    expect(toError("boom").message).toBe("boom");
    expect(toError(404).message).toBe("404");
    expect(toError({ toString: () => "obj" }).message).toBe("obj");

    const original = new Error("kept");
    expect(toError(original)).toBe(original);
  });
});

describe("internal/timing", () => {
  it("grows a fixed backoff not at all and an exponential one by powers of two", () => {
    const fixed = { delay: 100 };
    expect(backoffFromOptions(fixed, 1)).toBe(100);
    expect(backoffFromOptions(fixed, 5)).toBe(100);

    const exponential = { type: "exponential" as const, delay: 100 };
    expect(backoffFromOptions(exponential, 1)).toBe(100);
    expect(backoffFromOptions(exponential, 2)).toBe(200);
    expect(backoffFromOptions(exponential, 4)).toBe(800);
  });

  it("keeps jitter inside the documented band", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect(backoffFromOptions({ delay: 100, jitter: 0.2 }, 1)).toBe(100);
      random.mockReturnValue(1);
      expect(backoffFromOptions({ delay: 100, jitter: 0.2 }, 1)).toBe(80);
      // A jitter above 1 is clamped rather than producing a negative delay.
      expect(backoffFromOptions({ delay: 100, jitter: 5 }, 1)).toBe(0);
    } finally {
      random.mockRestore();
    }
  });

  it("rejects a delay that would misbehave as a timer", () => {
    expect(() => backoffFromOptions({ delay: -1 }, 1)).toThrow(
      "backoff delay must be a non-negative finite number"
    );
    // Exponential growth overflows rather than silently scheduling Infinity.
    expect(() =>
      backoffFromOptions({ type: "exponential", delay: 100 }, 5000)
    ).toThrow("backoff delay");
  });

  it("resolves a delay, a date, or nothing into a timestamp", () => {
    const now = 1_000_000;
    expect(resolveRunAt(undefined, now)).toBe(now);
    expect(resolveRunAt(0, now)).toBe(now);
    expect(resolveRunAt(500, now)).toBe(now + 500);
    expect(resolveRunAt(new Date(now + 5000), now)).toBe(now + 5000);
    // A date already in the past runs immediately rather than in the past.
    expect(resolveRunAt(new Date(now - 5000), now)).toBe(now);
  });

  it("rejects an unusable delay", () => {
    expect(() => resolveRunAt(-1, 0)).toThrow("delay");
    expect(() => resolveRunAt(new Date("nonsense"), 0)).toThrow(
      "delay date must be valid"
    );
  });

  it("sleeps for at least the requested time", async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

describe("internal/object", () => {
  it("drops only the keys that are undefined", () => {
    expect(compact({ a: 1, b: undefined, c: null, d: 0, e: "" })).toEqual({
      a: 1,
      c: null,
      d: 0,
      e: "",
    });
  });

  it("returns an object with no inherited keys", () => {
    const result = compact({ a: undefined });
    expect(Object.keys(result)).toEqual([]);
  });
});
