import { expect, test } from "vitest";
import { CopilotProjection } from "../../../src/commands/controller/providers/copilot-projection.js";
import type { MarkdownTimelineMetadata, ProviderEntry } from "../../../src/commands/controller/providers/types.js";

const event = (id: string, type: string, second: number, data: Record<string, unknown> = {}, agentId?: string) => ({
  id, type, timestamp: new Date(Date.UTC(2026, 10, 19, 11, 0, second)).toISOString(), data, ...(agentId ? { agentId } : {}),
});
const start = (id: string, second: number, agentId?: string) => event(id, "tool.execution_start", second, { toolCallId: id, toolName: "bash", arguments: { command: "sleep 90" } }, agentId);
const abort = (id: string, second: number, agentId?: string) => event(id, "abort", second, { reason: "user_abort" }, agentId);
const setup = () => {
  const entries: ProviderEntry[] = [], metadata: Array<MarkdownTimelineMetadata | undefined> = [];
  const projection = new CopilotProjection("native-session", (entry, value) => { entries.push(entry); metadata.push(value); });
  return { entries, metadata, projection, current: () => [...new Map(entries.map(entry => [entry.entryId, entry])).values()] };
};

test("native user abort closes the unfinished tool after turn_end and publishes the conversation interruption", () => {
  const f = setup();
  f.projection.accept(event("turn", "assistant.turn_start", 0, { turnId: "0" }));
  f.projection.accept(start("sleep", 1));
  const original = f.entries[0]!;
  f.projection.accept(event("partial", "tool.execution_partial_result", 2, { toolCallId: "sleep", partialOutput: "already printed\n" }));
  f.projection.accept(event("end", "assistant.turn_end", 3, { turnId: "0" }));
  f.projection.accept(abort("cancel", 4));
  expect(f.current()).toEqual([
    { ...original, status: "failed", output: [{ type: "text", text: "already printed\n" }, { type: "text", text: "Interrupted by the user before a completion result was recorded." }] },
    expect.objectContaining({ kind: "error", code: "turn_interrupted", message: "Interrupted by the user." }),
  ]);
  expect(f.metadata.at(-2)).toEqual({ complete: true, format: "plain", truncated: false });
  expect(JSON.stringify(f.current())).not.toMatch(/exitCode|execution_complete/);
});

test("interruption preserves bounded partial output and its truncation flag", () => {
  const f = setup(); f.projection.accept(start("sleep", 0));
  f.projection.accept(event("partial", "tool.execution_partial_result", 1, { toolCallId: "sleep", partialOutput: "x".repeat(210_000) }));
  const partial = f.entries.at(-1)!;
  f.projection.accept(abort("cancel", 2));
  const result = f.current()[0];
  if (partial.kind !== "tool_call" || result?.kind !== "tool_call") throw new Error("Expected tool entries");
  expect(result).toMatchObject({ entryId: partial.entryId, input: partial.input, callId: partial.callId, truncated: true, status: "failed" });
  expect(result.output.slice(0, -1)).toEqual(partial.output);
  expect(result.output.at(-1)).toEqual({ type: "text", text: "Interrupted by the user before a completion result was recorded." });
  expect(f.metadata.at(-2)).toEqual({ complete: true, format: "plain", truncated: true });
});

test.each(["user_abort", "user_initiated"])("%s without a tool still has one stable interruption through duplicate delivery", reason => {
  const f = setup(), cancellation = event("cancel", "abort", 1, { reason });
  f.projection.accept(cancellation); f.projection.accept(cancellation);
  expect(f.entries).toHaveLength(1);
  expect(f.entries[0]).toMatchObject({ kind: "error", code: "turn_interrupted" });
  const replay = setup(); replay.projection.accept(cancellation);
  expect(replay.current()).toEqual(f.current());
});

test.each(["remote_command", "autopilot_credit_limit", undefined])("abort reason %s does not invent user intent", reason => {
  const f = setup(); f.projection.accept(start("unknown", 0));
  f.projection.accept(event("outcome", "abort", 1, { reason }));
  expect(f.current()).toEqual([expect.objectContaining({ status: "running" })]);
});

test.each(["child", "parent-tool"])("child abort isolates %s ownership from root and other child tools", owner => {
  const f = setup();
  f.projection.accept(start("root", 0)); f.projection.accept(start("other", 0, "other-child"));
  const child = start("child-tool", 1, owner), cancellation = abort("child-cancel", 2, owner);
  if (owner === "parent-tool") {
    delete child.agentId; delete cancellation.agentId;
    Object.assign(child.data, { parentToolCallId: owner }); Object.assign(cancellation.data, { parentToolCallId: owner });
  }
  f.projection.accept(child); f.projection.accept(cancellation);
  expect(f.current()).toEqual([
    expect.objectContaining({ callId: "root", status: "running" }),
    expect.objectContaining({ callId: "other", status: "running" }),
    expect.objectContaining({ callId: "child-tool", status: "failed" }),
    expect.objectContaining({ kind: "error", code: "subagent_interrupted", message: `[Subagent ${owner}] Interrupted by the user.` }),
  ]);
});

test("root cancellation touches only its current turn and owner", () => {
  const f = setup();
  f.projection.accept(event("first", "user.message", 0)); f.projection.accept(start("unknown-old", 1));
  f.projection.accept(event("second", "user.message", 2)); f.projection.accept(start("current", 3));
  f.projection.accept(start("child", 3, "child-owner")); f.projection.accept(abort("cancel", 4));
  expect(f.current().filter(entry => entry.kind === "tool_call")).toMatchObject([
    { callId: "unknown-old", status: "running" }, { callId: "current", status: "failed" }, { callId: "child", status: "running" },
  ]);
});

test("late cancellation and duplicate turn_start cannot cancel next-turn tools", () => {
  const f = setup(), first = event("first", "assistant.turn_start", 0, { interactionId: "first-interaction" });
  f.projection.accept(first); f.projection.accept(start("old", 1));
  f.projection.accept(event("second", "assistant.turn_start", 4, { interactionId: "second-interaction" })); f.projection.accept(start("new", 5));
  f.projection.accept(first); f.projection.accept(abort("old-cancel", 3));
  expect(f.current().filter(entry => entry.kind === "tool_call")).toMatchObject([{ callId: "old", status: "failed" }, { callId: "new", status: "running" }]);
  f.projection.accept(event("complete", "tool.execution_complete", 6, { toolCallId: "new", success: true, result: "done" }));
  expect(f.current()[1]).toMatchObject({ callId: "new", status: "completed" });
});

test("a delayed pre-abort tool start cannot become running or revive through later partial/start/complete events", () => {
  const f = setup(); f.projection.accept(event("turn", "assistant.turn_start", 0)); f.projection.accept(abort("cancel", 3));
  f.projection.accept(start("late", 1));
  const count = f.entries.length;
  f.projection.accept(event("partial", "tool.execution_partial_result", 2, { toolCallId: "late", partialOutput: "stale" }));
  f.projection.accept(start("late", 1));
  f.projection.accept(event("complete", "tool.execution_complete", 4, { toolCallId: "late", success: true, result: "late completion" }));
  expect(f.entries).toHaveLength(count);
  expect(f.current()[1]).toMatchObject({ callId: "late", status: "failed" });
  expect(f.entries.some(entry => entry.kind === "tool_call" && entry.status === "running")).toBe(false);
});

test("a direct native predecessor disambiguates a late tool start sharing the abort timestamp", () => {
  const f = setup(); f.projection.accept(event("turn", "assistant.turn_start", 0));
  f.projection.accept({ ...abort("cancel", 1), parentId: "late" });
  f.projection.accept({ ...start("late", 1), parentId: "turn" });
  expect(f.current()).toMatchObject([{ code: "turn_interrupted" }, { callId: "late", status: "failed" }]);
  expect(f.entries.some(entry => entry.kind === "tool_call" && entry.status === "running")).toBe(false);
});

test("already terminal tools retain native completion even when start and abort arrive later", () => {
  const f = setup();
  f.projection.accept(event("complete", "tool.execution_complete", 2, { toolCallId: "done", success: true, result: "completed natively" }));
  f.projection.accept(start("done", 1)); f.projection.accept(abort("cancel", 3));
  expect(f.current()[0]).toMatchObject({ callId: "done", status: "completed", output: [{ type: "text", text: "completed natively" }] });
});

test.each([undefined, "steered-interaction"])("agentic loop iterations and steering with interaction %s retain the user cancellation scope", interactionId => {
  const f = setup();
  f.projection.accept(event("user", "user.message", 0, { interactionId: "interaction" }));
  f.projection.accept(event("first", "assistant.turn_start", 1, { turnId: "0", interactionId: "interaction" }));
  f.projection.accept(start("background", 2));
  f.projection.accept(event("end", "assistant.turn_end", 3, { turnId: "0" }));
  f.projection.accept(event("steer", "user.message", 4, { delivery: "steering", interactionId }));
  f.projection.accept(event("second", "assistant.turn_start", 5, { turnId: "1", interactionId: interactionId ?? "interaction" }));
  f.projection.accept(start("foreground", 6)); f.projection.accept(abort("cancel", 7));
  expect(f.current().filter(entry => entry.kind === "tool_call")).toMatchObject([{ callId: "background", status: "failed" }, { callId: "foreground", status: "failed" }]);
});

test.each(["session.error", "session.shutdown", "session.idle", "assistant.turn_end", "abort"])("%s without user cancellation evidence does not infer interruption", type => {
  const f = setup(); f.projection.accept(start("unknown", 0));
  f.projection.accept(event("outcome", type, 1, { message: "Disconnected", reason: "autopilot_credit_limit" }));
  expect(f.current()[0]).toMatchObject({ status: "running" });
  expect(f.entries.some(entry => entry.kind === "error" && entry.code === "turn_interrupted")).toBe(false);
});

test("live duplicate delivery and chronological native-history replay yield equal terminal entries", () => {
  const history = [event("turn", "assistant.turn_start", 0), start("sleep", 1), event("end", "assistant.turn_end", 2), abort("cancel", 3), event("next", "assistant.turn_start", 4), event("message", "assistant.message", 5, { messageId: "reply", content: "Next message completed." })];
  const live = setup(), replay = setup();
  for (const raw of history) { live.projection.accept(raw); live.projection.accept(raw); replay.projection.accept(raw); }
  expect(live.current()).toEqual(replay.current());
  expect(live.current()).toMatchObject([{ status: "failed" }, { code: "turn_interrupted" }, { kind: "assistant_message" }]);
});
