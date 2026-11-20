import { describe, expect, it } from "vitest";
import { getFormats } from "../../src/i18n/formats";
import type { Locale } from "../../src/i18n/locale";
import { messagesByLocale } from "../../src/i18n/messages";
import type { Messages } from "../../src/i18n/messages";

type CountMessages = Messages & {
  readonly count: (args: { readonly count: number }) => string;
};

const countMessages: Readonly<Record<Locale, CountMessages>> = {
  en: { ...messagesByLocale.en, count: ({ count }) => `${getFormats("en").number(count)} ${getFormats("en").plural(count) === "one" ? "task" : "tasks"}` },
  "zh-CN": { ...messagesByLocale["zh-CN"], count: ({ count }) => `${getFormats("zh-CN").number(count)} 个任务` },
};

describe("language formats and messages", () => {
  it.each(["en", "zh-CN"] as const)("preserves local dates, seconds and 24-hour times for %s", (locale) => {
    const format = getFormats(locale);
    const date = new Date(2026, 9, 22, 19, 8, 6);
    const timestamp = date.getTime();
    expect(format.date(date)).toBe(locale === "en" ? "10/22/2026" : "2026/10/22");
    expect(format.time(timestamp)).toBe("19:08:06");
    expect(format.dateTime(date.toISOString())).toBe(locale === "en" ? "10/22/2026, 19:08:06" : "2026/10/22 19:08:06");
    expect(date.getTime()).toBe(timestamp);
    expect(getFormats(locale)).toBe(format);
    expect(() => format.date("invalid timestamp")).toThrow(RangeError);
  });

  it.each(["en", "zh-CN"] as const)("groups numbers and exact unscaled byte values for %s", (locale) => {
    const format = getFormats(locale);
    expect([0, 1, 12345.678].map(format.number)).toEqual(["0", "1", "12,345.678"]);
    expect([0, 1, 12345].map(format.bytes)).toEqual(["0 B", "1 B", "12,345 B"]);
    expect(format.bytes(9007199254740993n)).toBe("9,007,199,254,740,993 B");
  });

  it("supports complete named-argument messages for zero, singular and plural quantities", () => {
    expect([0, 1, 12].map((count) => countMessages.en.count({ count }))).toEqual(["0 tasks", "1 task", "12 tasks"]);
    expect([0, 1, 12].map((count) => countMessages["zh-CN"].count({ count }))).toEqual(["0 个任务", "1 个任务", "12 个任务"]);
    expect([0, 1, 12].map(getFormats("en").plural)).toEqual(["other", "one", "other"]);
    expect([0, 1, 12].map(getFormats("zh-CN").plural)).toEqual(["other", "other", "other"]);
    expect(getFormats("en")).not.toBe(getFormats("zh-CN"));
  });
});

describe("execution duration formats", () => {
  it.each([
    [0, "< 1 min", "不足 1 分钟"],
    [59_999, "< 1 min", "不足 1 分钟"],
    [60_000, "1min", "1 分钟"],
    [3_599_000, "59min", "59 分钟"],
    [3_600_000, "1h", "1 小时"],
    [3_601_000, "1h", "1 小时"],
    [183_840_000, "2d 3h 4min", "2 天 3 小时 4 分钟"],
  ])("formats %i milliseconds without rounding the warning boundary", (milliseconds, en, zh) => {
    expect(getFormats("en").duration(milliseconds as number)).toBe(en);
    expect(getFormats("zh-CN").duration(milliseconds as number)).toBe(zh);
  });
});


describe("graph execution duration", () => {
  it.each([
    [59_999, "< 1 min", "不足 1 分钟"],
    [60_000, "1min", "1 分钟"],
    [3_599_999, "59min", "59 分钟"],
    [3_600_000, "1h", "1 小时"],
    [4_200_000, "1h 10min", "1 小时 10 分钟"],
    [86_400_000, "1d", "1 天"],
    [86_700_000, "1d", "1 天"],
    [183_840_000, "2d 3h", "2 天 3 小时"],
  ])("formats %i milliseconds using adjacent units only", (milliseconds, en, zh) => {
    expect(getFormats("en").graphDuration(milliseconds as number)).toBe(en);
    expect(getFormats("zh-CN").graphDuration(milliseconds as number)).toBe(zh);
  });
});
