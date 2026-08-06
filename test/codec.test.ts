import { describe, expect, it } from "vitest";
import {
  JobSerializationError,
  cloneJobValue,
  decodeJobValue,
  encodeJobValue,
} from "../src/codec.js";

describe("job value codec", () => {
  it("round-trips the JSON-safe values a job may carry", () => {
    const value = {
      string: "a",
      number: 1.5,
      boolean: false,
      null: null,
      nested: { list: [1, "two", { three: true }] },
      empty: {},
      emptyList: [],
    };
    expect(cloneJobValue(value)).toEqual(value);
  });

  it("clones deeply so later mutation cannot reach the stored job", () => {
    const input = { nested: { items: [1, 2] } };
    const clone = cloneJobValue(input);
    input.nested.items.push(3);
    expect(clone.nested.items).toEqual([1, 2]);
  });

  it("treats undefined as a root-only value", () => {
    expect(cloneJobValue(undefined)).toBeUndefined();
    expect(decodeJobValue(encodeJobValue(undefined))).toBeUndefined();
    expect(() => encodeJobValue({ field: undefined })).toThrow(
      JobSerializationError
    );
    expect(() => encodeJobValue([undefined])).toThrow(
      "$[0] is not JSON-safe"
    );
  });

  it("names the exact path that failed", () => {
    try {
      encodeJobValue({ outer: { list: [1, () => 1] } });
      expect.unreachable("expected a JobSerializationError");
    } catch (cause) {
      const error = cause as JobSerializationError;
      expect(error).toBeInstanceOf(JobSerializationError);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.path).toBe("$.outer.list[1]");
      expect(error.message).toContain("function is unsupported");
    }
  });

  it.each([
    ["NaN", Number.NaN, "numbers must be finite"],
    ["Infinity", Number.POSITIVE_INFINITY, "numbers must be finite"],
    ["a bigint", 1n, "bigint is unsupported"],
    ["a symbol", Symbol("nope"), "symbol is unsupported"],
    ["a function", () => undefined, "function is unsupported"],
  ])("rejects %s", (_label, value, reason) => {
    expect(() => encodeJobValue({ field: value })).toThrow(reason);
  });

  it("rejects values that JSON cannot represent faithfully", () => {
    expect(() => encodeJobValue(new Date())).toThrow(
      "only plain objects and arrays are supported"
    );
    expect(() => encodeJobValue(new Map())).toThrow(
      "only plain objects and arrays are supported"
    );
    expect(() => encodeJobValue(new Set([1]))).toThrow(
      "only plain objects and arrays are supported"
    );
    expect(() => encodeJobValue(/regex/)).toThrow(
      "only plain objects and arrays are supported"
    );
  });

  it("rejects sparse arrays rather than silently filling holes", () => {
    const sparse = [1, , 3] as unknown[];
    expect(() => encodeJobValue(sparse)).toThrow(
      "sparse array entries are unsupported"
    );
  });

  it("rejects a cycle instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    expect(() => encodeJobValue(cyclic)).toThrow("circular reference");

    const viaArray: unknown[] = [];
    viaArray.push(viaArray);
    expect(() => encodeJobValue(viaArray)).toThrow("circular reference");
  });

  it("allows the same object twice when it is not an ancestor", () => {
    const shared = { id: 1 };
    expect(cloneJobValue({ a: shared, b: shared })).toEqual({
      a: { id: 1 },
      b: { id: 1 },
    });
  });

  it("accepts a null-prototype object", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.value = 1;
    expect(cloneJobValue(bare)).toEqual({ value: 1 });
  });

  it("distinguishes a stored undefined from a missing envelope value", () => {
    expect(decodeJobValue('{"value":null}')).toBeNull();
    expect(decodeJobValue("{}")).toBeUndefined();
  });
});
