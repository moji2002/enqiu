import { describe, expect, it } from "vitest";
import { JobSerializationError, assertJobValue } from "../src/serialize.js";

describe("job value serialization check", () => {
  it("passes the JSON-safe values a job may carry through untouched", () => {
    const value = {
      string: "a",
      number: 1.5,
      boolean: false,
      null: null,
      nested: { list: [1, "two", { three: true }] },
      empty: {},
      emptyList: [],
    };
    expect(assertJobValue(value)).toBe(value);
  });

  it("treats undefined as a root-only value", () => {
    expect(assertJobValue(undefined)).toBeUndefined();
    expect(() => assertJobValue({ field: undefined })).toThrow(
      JobSerializationError
    );
    expect(() => assertJobValue([undefined])).toThrow("$[0] is not JSON-safe");
  });

  it("names the exact path that failed", () => {
    try {
      assertJobValue({ outer: { list: [1, () => 1] } });
      expect.unreachable("expected a JobSerializationError");
    } catch (cause) {
      const error = cause as JobSerializationError;
      expect(error).toBeInstanceOf(JobSerializationError);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.path).toBe("$.outer.list[1]");
      expect(error.message).toContain("function is unsupported");
    }
  });

  it("reports the root itself as $", () => {
    expect(() => assertJobValue(() => 1)).toThrow("Job data at $ is not");
  });

  it.each([
    ["NaN", Number.NaN, "numbers must be finite"],
    ["Infinity", Number.POSITIVE_INFINITY, "numbers must be finite"],
    ["a bigint", 1n, "bigint is unsupported"],
    ["a symbol", Symbol("nope"), "symbol is unsupported"],
    ["a function", () => undefined, "function is unsupported"],
  ])("rejects %s", (_label, value, reason) => {
    expect(() => assertJobValue({ field: value })).toThrow(reason);
  });

  it("rejects values that JSON cannot represent faithfully", () => {
    expect(() => assertJobValue(new Date())).toThrow(
      "only plain objects and arrays are supported"
    );
    expect(() => assertJobValue(new Map())).toThrow(
      "only plain objects and arrays are supported"
    );
    expect(() => assertJobValue(new Set([1]))).toThrow(
      "only plain objects and arrays are supported"
    );
    expect(() => assertJobValue(/regex/)).toThrow(
      "only plain objects and arrays are supported"
    );
  });

  it("rejects sparse arrays rather than silently filling holes", () => {
    const sparse = [1, , 3] as unknown[];
    expect(() => assertJobValue(sparse)).toThrow(
      "sparse array entries are unsupported"
    );
  });

  it("rejects a cycle instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(() => assertJobValue(cyclic)).toThrow("circular reference");

    const viaArray: unknown[] = [];
    viaArray.push(viaArray);
    expect(() => assertJobValue(viaArray)).toThrow("circular reference");
  });

  it("allows the same object twice when it is not an ancestor", () => {
    const shared = { id: 1 };
    expect(() => assertJobValue({ a: shared, b: shared })).not.toThrow();
    expect(() => assertJobValue([shared, [shared]])).not.toThrow();
  });

  it("accepts a null-prototype object", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.value = 1;
    expect(() => assertJobValue(bare)).not.toThrow();
  });
});
