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
