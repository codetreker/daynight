import { describe, expect, it } from "vitest";
import type { AssistantTask } from "../../../../src/api/assistant-task.js";
import { assistantTriggerId, assistantTriggerOccurrence } from "../../../../src/commands/worker/bots/assistant-task-trigger.js";

const task = (trigger: AssistantTask["trigger"]): AssistantTask => ({ id: "00000000-0000-4000-8000-000000000001", trigger, createdAt: "2026-11-13T00:00:00Z" }) as AssistantTask;
describe("assistant-task schedule occurrences", () => {
  it("starts intervals after a full period and selects only the latest missed occurrence", () => {
    const item = task({ kind: "interval", minutes: 2 }), start = Date.parse(item.createdAt);
    expect(assistantTriggerOccurrence(item, start + 119_999)).toBeNull();
    expect(assistantTriggerOccurrence(item, start + 120_000)).toBe("2026-11-13T00:02:00.000Z");
    expect(assistantTriggerOccurrence(item, start + 721_000)).toBe("2026-11-13T00:12:00.000Z");
  });
  it("uses the explicit daily time zone and returns one identity across a repeated DST hour", () => {
    const daily = task({ kind: "daily", time: "09:00", timeZone: "Asia/Shanghai" });
    expect(assistantTriggerOccurrence(daily, Date.parse("2026-11-13T00:59:59Z"))).toBeNull();
    expect(assistantTriggerOccurrence(daily, Date.parse("2026-11-13T01:00:00Z"))).toBe("2026-11-13T09:00[Asia/Shanghai]");
    const dst = task({ kind: "daily", time: "01:30", timeZone: "America/New_York" });
    dst.createdAt = "2026-10-31T00:00:00Z";
    expect(assistantTriggerOccurrence(dst, Date.parse("2026-11-01T05:30:00Z"))).toBe(assistantTriggerOccurrence(dst, Date.parse("2026-11-01T06:30:00Z")));
  });
  it("keeps occurrence IDs stable across holders and changes them for another schedule or occurrence", () => {
    const schedule = { kind: "interval", minutes: 2 }, time = "2026-11-13T00:02:00Z", item = task(schedule);
    const first = assistantTriggerId(item.id, schedule, time);
    expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(assistantTriggerId(item.id, schedule, time)).toBe(first);
    expect(assistantTriggerId(item.id, { kind: "interval", minutes: 3 }, time)).not.toBe(first);
    expect(assistantTriggerId(item.id, schedule, "2026-11-13T00:04:00Z")).not.toBe(first);
  });
  it("accepts disabled schedules and refuses unsupported trigger data", () => {
    expect(assistantTriggerOccurrence(task(null), Date.now())).toBeNull();
    for (const trigger of [{ kind: "interval", minutes: 0 }, { kind: "interval", minutes: 1.5 }, { kind: "daily", time: "25:00", timeZone: "UTC" }, { kind: "daily", time: "09:00", timeZone: "invalid/zone" }]) expect(() => assistantTriggerOccurrence(task(trigger), Date.now())).toThrow();
  });
});
