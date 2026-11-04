import { expect, test } from "vitest";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
import { parseTimelineEntry } from "../../../src/session/protocol.js";

const activity = { type: "subAgentActivity", id: "activity-1", kind: "started", agentPath: "/root/relay_research", agentThreadId: "child-thread", model: "gpt-6-astra", reasoningEffort: "medium", startedAtMs: 1793708973702, completedAtMs: 1793708973702 };

test.each([
  ["started", "Start subagent"], ["interacted", "Interact with subagent"],
  ["interrupted", "Interrupt subagent"], ["future-kind", "Subagent activity"],
])("projects %s as an operation, not a child task outcome", (kind, name) => {
  const entries: ProviderEntry[] = [];
  const projection = new CodexProjection("parent-session", entry => entries.push(entry));
  projection.item({ ...activity, kind }, false);
  projection.item({ ...activity, kind }, true);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ kind: "tool_call", name, status: "running", callId: "activity-1" });
  expect(entries[1]).toMatchObject({ kind: "tool_call", name, status: "completed", output: [] });
  expect(entries[1]!.entryId).toBe(entries[0]!.entryId);
  if (entries[1]!.kind !== "tool_call") throw new Error("Missing activity operation");
  expect(JSON.parse(entries[1]!.input)).toMatchObject({ path: "/root/relay_research", agentThreadId: "child-thread", activityKind: kind });
  expect(() => parseTimelineEntry({ ...entries[1], entrySeq: "1" })).not.toThrow();
  const restored: ProviderEntry[] = [];
  new CodexProjection("parent-session", entry => restored.push(entry)).item({ ...activity, kind }, true);
  expect(restored).toEqual([entries[1]]);
});

test("handles missing optional activity metadata without swallowing other unknown items", () => {
  const entries: ProviderEntry[] = [];
  const projection = new CodexProjection("parent-session", entry => entries.push(entry));
  projection.item({ type: "subAgentActivity", id: "minimal" }, true);
  projection.item({ type: "futureNativeItem", id: "unknown" }, true);
  expect(entries[0]).toMatchObject({ kind: "tool_call", name: "Subagent activity", status: "completed" });
  expect(entries[1]).toMatchObject({ kind: "error", code: "unsupported_native_item" });
});
