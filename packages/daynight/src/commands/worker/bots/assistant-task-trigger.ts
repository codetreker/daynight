import { createHash } from "node:crypto";
import type { AssistantTask, JsonValue } from "../../../api/assistant-task.js";

/** Return the latest due occurrence, never an offline backlog. Daily schedules use the named zone. */
export const assistantTriggerOccurrence = (task: AssistantTask, now: number): string | null => {
  const trigger = task.trigger as { kind?: string; minutes?: number; time?: string; timeZone?: string } | null;
  if (!trigger) return null;
  if (trigger.kind === "interval" && Number.isSafeInteger(trigger.minutes) && trigger.minutes! >= 1) {
    const period = trigger.minutes! * 60_000, start = Date.parse(task.createdAt);
    const count = Math.floor((now - start) / period);
    return count < 1 ? null : new Date(start + count * period).toISOString();
  }
  if (trigger.kind === "daily" && typeof trigger.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) && trigger.timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: trigger.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === name)!.value;
    if (`${part("hour")}:${part("minute")}` < trigger.time) return null;
    // The local date identifies one occurrence even when the clock repeats at a DST transition.
    return `${part("year")}-${part("month")}-${part("day")}T${trigger.time}[${trigger.timeZone}]`;
  }
  throw new Error("Unsupported assistant-task trigger.");
};

export const assistantTriggerId = (taskId: string, trigger: JsonValue, occurrence: string): string => {
  const hash = createHash("sha256").update(JSON.stringify(["daynight-assistant-trigger/1", taskId, trigger, occurrence])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
