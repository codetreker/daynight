import { expect, test } from "vitest";
import { CopilotProjection } from "../../../src/commands/controller/providers/copilot-projection.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
const setup = () => { const entries: ProviderEntry[] = []; return { entries, projection: new CopilotProjection("session", entry => entries.push(entry)) }; };
test("Copilot final reasoning and message correct the stable streamed row, ignoring late deltas", () => {
  const { entries, projection } = setup();
  for (const [type, data] of [["assistant.message_delta", { messageId: "m", deltaContent: "draft" }], ["assistant.message", { messageId: "m", content: "final" }], ["assistant.message_delta", { messageId: "m", deltaContent: "stale" }], ["assistant.reasoning_delta", { reasoningId: "r", deltaContent: "draft reasoning" }], ["assistant.reasoning", { reasoningId: "r", content: "final reasoning" }]]) projection.accept({ id: type, type, data });
  expect(entries).toHaveLength(4); expect(entries[0]?.entryId).toBe(entries[1]?.entryId); expect(entries[2]?.entryId).toBe(entries[3]?.entryId);
  expect(entries[1]).toMatchObject({ content: [{ type: "text", text: "final" }] }); expect(entries[3]).toMatchObject({ text: "final reasoning" });
});
test("Copilot tool output uses native results, remains bounded and ignores post-completion partial output", () => {
  const { entries, projection } = setup();
  projection.accept({ id: "s", type: "tool.execution_start", data: { toolCallId: "t", toolName: "apply_patch", arguments: "intent" } });
  projection.accept({ id: "p", type: "tool.execution_partial_result", data: { toolCallId: "t", partialOutput: "x".repeat(210000) } });
  expect(entries.at(-1)).toMatchObject({ truncated: true });
  projection.accept({ id: "c", type: "tool.execution_complete", data: { toolCallId: "t", success: false, error: { message: "permission denied" } } });
  projection.accept({ id: "late", type: "tool.execution_partial_result", data: { toolCallId: "t", partialOutput: "must not revive" } });
  expect(entries).toHaveLength(3); expect(entries.at(-1)).toMatchObject({ status: "failed", input: "intent", output: [{ type: "text", text: "permission denied" }] });
});
test("Copilot failed compaction and unsupported binary content stay visible", () => {
  const { entries, projection } = setup();
  projection.accept({ id: "c", type: "session.compaction_complete", data: { success: false, error: "failure" } });
  projection.accept({ id: "i", type: "session.binary_asset", data: { bytes: "secret pixels" } });
  expect(entries.map(e => e.kind)).toEqual(["error", "error"]); expect(JSON.stringify(entries)).not.toContain("secret pixels");
});
test("Copilot namespaces child content independently from foreground IDs", () => {
  const { entries, projection } = setup();
  projection.accept({ id: "p", type: "assistant.message", data: { messageId: "m", content: "root" } });
  projection.accept({ id: "c", agentId: "child", type: "assistant.message", data: { messageId: "m", content: "child" } });
  expect(entries[0]?.entryId).not.toBe(entries[1]?.entryId);
});
test("Copilot renders identical summary and detailed output once without deleting repeated native lines", () => {
  const { entries, projection } = setup();
  const output = "# raw-heading\nrepeat\nrepeat\n<shellId: 0 completed with exit code 3>";
  projection.accept({ id: "c", type: "tool.execution_complete", data: { toolCallId: "t", success: true, result: { content: output, detailedContent: output } } });
  expect(entries.at(-1)).toMatchObject({ status: "completed", output: [{ type: "text", text: output }], truncated: false });
});
test("Copilot retains distinct summary, detail and structured result content", () => {
  const { entries, projection } = setup();
  projection.accept({ id: "c", type: "tool.execution_complete", data: { toolCallId: "t", success: true, result: { content: "summary", detailedContent: "full output", structuredContent: { count: 2 } } } });
  expect(entries.at(-1)).toMatchObject({ output: [{ type: "text", text: 'summary\nfull output\n{\n  "count": 2\n}' }] });
});
test("Copilot retains failed tool output together with its native error", () => {
  const { entries, projection } = setup();
  projection.accept({ id: "c", type: "tool.execution_complete", data: { toolCallId: "t", success: false, error: { message: "permission denied" }, result: { content: "partial output", detailedContent: "partial output" } } });
  expect(entries.at(-1)).toMatchObject({ status: "failed", output: [{ type: "text", text: "permission denied\npartial output" }] });
});
test("Copilot does not truncate a result merely because its summary duplicates the detail", () => {
  const { entries, projection } = setup(); const output = "x".repeat(150_000);
  projection.accept({ id: "c", type: "tool.execution_complete", data: { toolCallId: "t", success: true, result: { content: output, detailedContent: output } } });
  const entry = entries.at(-1); expect(entry).toMatchObject({ truncated: false });
  if (entry?.kind !== "tool_call") throw new Error("Expected tool result");
  expect(entry.output).toHaveLength(1); expect(entry.output[0]?.type === "text" && entry.output[0].text.length).toBe(150_000);
});
test("Copilot displays a failed tool's identical error and output once", () => {
  const { entries, projection } = setup();
  projection.accept({ id: "c", type: "tool.execution_complete", data: { toolCallId: "t", success: false, error: { message: "permission denied" }, result: { content: "permission denied", detailedContent: "permission denied" } } });
  expect(entries.at(-1)).toMatchObject({ status: "failed", output: [{ type: "text", text: "permission denied" }] });
});
