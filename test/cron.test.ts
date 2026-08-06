import { describe, expect, it } from "vitest";
import {
  CronExpressionError,
  nextCronOccurrence,
  parseCron,
} from "../src/cron.js";

describe("cron", () => {
  it("parses standard ranges, lists, steps, and names", () => {
    const cron = parseCron("*/15 9-17 * jan,mar mon-fri");
    expect(cron.minute.values).toEqual(new Set([0, 15, 30, 45]));
    expect(cron.hour.values.has(17)).toBe(true);
    expect(cron.month.values).toEqual(new Set([1, 3]));
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("finds the next occurrence in an IANA timezone", () => {
    const after = Date.UTC(2026, 6, 27, 5, 59);
    expect(
      nextCronOccurrence(
        "0 9 * * 1-5",
        "Europe/Nicosia",
        after
      )
    ).toBe(Date.UTC(2026, 6, 27, 6, 0));
  });

  it("skips local times that do not exist during spring DST", () => {
    const first = Date.UTC(2026, 2, 7, 7, 30);
    expect(
      nextCronOccurrence("30 2 * * *", "America/New_York", first)
    ).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it("returns both repeated local times during autumn DST", () => {
    const firstOccurrence = Date.UTC(2026, 10, 1, 5, 30);
    expect(
      nextCronOccurrence(
        "30 1 * * *",
        "America/New_York",
        firstOccurrence
      )
    ).toBe(Date.UTC(2026, 10, 1, 6, 30));
  });

  it("rejects malformed expressions and timezones", () => {
    expect(() => parseCron("* * *")).toThrow(CronExpressionError);
    expect(() => parseCron("60 * * * *")).toThrow(CronExpressionError);
    expect(() =>
      nextCronOccurrence("* * * * *", "Not/A_Zone", Date.now())
    ).toThrow("Invalid IANA timezone");
  });
});

describe("cron field parsing", () => {
  it("treats Sunday as both 0 and 7", () => {
    expect(parseCron("0 0 * * 0").dayOfWeek.values).toEqual(new Set([0]));
    expect(parseCron("0 0 * * 7").dayOfWeek.values).toEqual(new Set([0]));
    expect(parseCron("0 0 * * sun").dayOfWeek.values).toEqual(new Set([0]));
  });

  it("applies a step across an explicit range as well as a wildcard", () => {
    expect(parseCron("0-30/10 * * * *").minute.values).toEqual(
      new Set([0, 10, 20, 30])
    );
    expect(parseCron("*/20 * * * *").minute.values).toEqual(
      new Set([0, 20, 40])
    );
  });

  it("marks a field as a wildcard only when it spans the whole range", () => {
    expect(parseCron("* * * * *").dayOfMonth.wildcard).toBe(true);
    expect(parseCron("* * */2 * *").dayOfMonth.wildcard).toBe(true);
    expect(parseCron("* * 1-5 * *").dayOfMonth.wildcard).toBe(false);
  });

  it("accepts named months and weekday ranges case-insensitively", () => {
    expect(parseCron("0 0 * JAN-MAR *").month.values).toEqual(
      new Set([1, 2, 3])
    );
    expect(parseCron("0 0 * * SAT,SUN").dayOfWeek.values).toEqual(
      new Set([6, 0])
    );
  });

  it.each([
    ["an empty list entry", "0,,5 * * * *"],
    ["a doubled step separator", "0/2/3 * * * *"],
    ["a zero step", "*/0 * * * *"],
    ["a non-numeric step", "*/x * * * *"],
    ["a three-part range", "1-2-3 * * * *"],
    ["a reversed range", "30-10 * * * *"],
    ["a value below the minimum", "* * 0 * *"],
    ["a value above the maximum", "* 24 * * *"],
    ["an unknown name", "0 0 * smarch *"],
  ])("rejects %s", (_label, expression) => {
    expect(() => parseCron(expression)).toThrow(CronExpressionError);
  });
});

describe("cron day-of-month and day-of-week interaction", () => {
  // Vixie cron ORs the two day fields when both are restricted, and ANDs them
  // when either is a wildcard. Getting this backwards silently skips runs.
  it("ORs the day fields when both are restricted", () => {
    const cron = parseCron("0 0 13 * fri");
    // The 13th of June 2026 is a Saturday, so day-of-month alone matches it.
    const after = Date.UTC(2026, 5, 12, 12, 0);
    expect(nextCronOccurrence(cron, "UTC", after)).toBe(
      Date.UTC(2026, 5, 13, 0, 0)
    );
  });

  it("ANDs the day fields when one is a wildcard", () => {
    // Every Friday, regardless of date.
    const after = Date.UTC(2026, 5, 12, 12, 0);
    expect(nextCronOccurrence("0 0 * * fri", "UTC", after)).toBe(
      Date.UTC(2026, 5, 19, 0, 0)
    );
  });

  it("restricts to a single date when only day-of-month is set", () => {
    const after = Date.UTC(2026, 5, 12, 12, 0);
    expect(nextCronOccurrence("0 0 13 * *", "UTC", after)).toBe(
      Date.UTC(2026, 5, 13, 0, 0)
    );
  });
});

describe("cron occurrence guards", () => {
  it("requires a finite cursor", () => {
    expect(() =>
      nextCronOccurrence("* * * * *", "UTC", Number.NaN)
    ).toThrow("The cron cursor must be a finite timestamp");
    expect(() =>
      nextCronOccurrence("* * * * *", "UTC", Number.POSITIVE_INFINITY)
    ).toThrow("finite timestamp");
  });

  it("requires a non-empty timezone", () => {
    expect(() => nextCronOccurrence("* * * * *", "   ", Date.now())).toThrow(
      "timezone must not be empty"
    );
  });

  it("gives up on an expression that never fires", () => {
    // 30 February never occurs.
    expect(() =>
      nextCronOccurrence("0 0 30 2 *", "UTC", Date.UTC(2026, 0, 1))
    ).toThrow("has no occurrence within five years");
  });

  it("accepts a pre-parsed expression as well as a string", () => {
    const after = Date.UTC(2026, 0, 1, 0, 0);
    const parsed = parseCron("*/30 * * * *");
    expect(nextCronOccurrence(parsed, "UTC", after)).toBe(
      nextCronOccurrence("*/30 * * * *", "UTC", after)
    );
  });
});
