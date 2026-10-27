import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isRecentCompletion, recentTaskWindow, timestampNanoseconds } from "../src/features/projects/task-visibility";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src/features/projects/task-visibility.ts");
const calendarProbe = `
const { recentTaskWindow, timestampNanoseconds } = await import(process.argv[1]);
const window = recentTaskWindow(timestampNanoseconds(process.argv[2]));
const iso = (value) => new Date(Number(value / 1_000_000n)).toISOString();
process.stdout.write(JSON.stringify({ start: iso(window.start), nextMidnight: iso(window.nextMidnight), hours: Number(window.nextMidnight - window.start) / 3_600_000_000_000 }));
`;

// A fresh process makes each timezone effective in both Node and its Date runtime.
const calendarIn = (timezone: string, now: string): { start: string; nextMidnight: string; hours: number } =>
  JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", calendarProbe, source, now], {
    env: { ...process.env, TZ: timezone }, encoding: "utf8", timeout: 10_000,
  }));

describe("natural calendar task visibility", () => {
  it.each([
    { timezone: "UTC", now: "2026-03-09T12:00:00Z", start: "2026-03-03T00:00:00.000Z", nextMidnight: "2026-03-10T00:00:00.000Z", hours: 168 },
    { timezone: "Asia/Shanghai", now: "2026-10-26T17:00:00Z", start: "2026-10-20T16:00:00.000Z", nextMidnight: "2026-10-27T16:00:00.000Z", hours: 168 },
    { timezone: "America/New_York", now: "2026-03-09T16:00:00Z", start: "2026-03-03T05:00:00.000Z", nextMidnight: "2026-03-10T04:00:00.000Z", hours: 167 },
    { timezone: "America/New_York", now: "2026-11-02T17:00:00Z", start: "2026-10-27T04:00:00.000Z", nextMidnight: "2026-11-03T05:00:00.000Z", hours: 169 },
    { timezone: "America/Sao_Paulo", now: "2018-11-03T15:00:00Z", start: "2018-10-28T03:00:00.000Z", nextMidnight: "2018-11-04T03:00:00.000Z", hours: 168 },
  ])("includes today and the previous six local dates in $timezone at $now", ({ timezone, now, start, nextMidnight, hours }) => {
    expect(calendarIn(timezone, now)).toEqual({ start, nextMidnight, hours });
  });

  it("keeps the sixth previous date when the current local hour did not exist on that date", () => {
    expect(calendarIn("America/Nuuk", "2026-04-04T00:30:00Z")).toEqual({
      start: "2026-03-28T02:00:00.000Z", nextMidnight: "2026-04-04T01:00:00.000Z", hours: 167,
    });
  });

  it("schedules the next midnight before a following evening DST gap", () => {
    expect(calendarIn("America/Nuuk", "2026-03-28T01:30:00Z")).toEqual({
      start: "2026-03-21T02:00:00.000Z", nextMidnight: "2026-03-28T02:00:00.000Z", hours: 168,
    });
  });

  it("keeps exact midnight inclusive while rejecting the preceding nanosecond and unknown or future facts", () => {
    const now = timestampNanoseconds("2026-10-26T12:00:00.123456789Z");
    const window = recentTaskWindow(now);
    expect(isRecentCompletion(window.start, window)).toBe(true);
    expect(isRecentCompletion(window.start - 1n, window)).toBe(false);
    expect(isRecentCompletion(now, window)).toBe(true);
    expect(isRecentCompletion(now + 1n, window)).toBe(false);
    expect(isRecentCompletion(null, window)).toBe(false);
    expect(isRecentCompletion(window.start, recentTaskWindow(window.nextMidnight))).toBe(false);
  });

  it("compares canonical API timestamps without losing fractional precision", () => {
    expect(timestampNanoseconds("2026-10-26T12:00:00Z")).toBe(timestampNanoseconds("2026-10-26T12:00:00.000000000Z"));
    expect(timestampNanoseconds("2026-10-26T12:00:00.1Z")).toBe(timestampNanoseconds("2026-10-26T12:00:00.100000000Z"));
    expect(timestampNanoseconds("2026-10-26T12:00:00.123456790Z") - timestampNanoseconds("2026-10-26T12:00:00.123456789Z")).toBe(1n);
  });
});
