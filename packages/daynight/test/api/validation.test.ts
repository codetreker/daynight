import { describe, expect, it } from "vitest";
import { text, timestamp } from "../../src/api/validation.js";

describe("shared API field validation", () => {
  it.each(["  <原值&> 😀 \uFEFF  ", "\uFEFF", "# Markdown\n\t\"\\\u2028\u2029 �  "])("preserves nonempty Unicode text exactly: %j", (value) => {
    expect(text(value, true)).toBe(value);
  });

  it.each(["", " \u0085\u2000\t", "\0", "\ud800", null])("rejects invalid required text: %j", (value) => {
    expect(() => text(value, true)).toThrow();
  });

  it.each(["2024-02-29T00:00:00Z", "0001-01-01T00:00:00.000001Z", "2026-11-03T10:11:12.1Z", "2026-11-03T10:11:12.123000Z", "2026-11-03T10:11:12.123456789Z"])("preserves valid UTC timestamp precision: %s", (value) => {
    expect(timestamp(value)).toBe(value);
  });

  it.each(["2026-02-29T10:11:12Z", "2026-11-03T24:11:12Z", "2026-11-03T10:11:60Z", "2026-11-03T10:11:12+00:00", "2026-11-03T10:11:12.0z", "2026-11-03T10:11:12.1234567890Z", "infinity", ""])("rejects invalid UTC timestamps: %s", (value) => {
    expect(() => timestamp(value)).toThrow();
  });
});
