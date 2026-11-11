import { expect, test } from "vitest";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import { CopilotProjection } from "../../../src/commands/controller/providers/copilot-projection.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";

const projection = (provider: "codex" | "copilot") => {
  const events: { entry: ProviderEntry; metadata: unknown }[] = [];
  const emit = (entry: ProviderEntry, metadata?: unknown) => events.push({ entry, metadata });
  return { events, instance: provider === "codex" ? new CodexProjection("native", emit) : new CopilotProjection("native", emit) };
};
test("Codex marks complete native text while keeping deltas incomplete", () => {
  const { events, instance } = projection("codex"), p = instance as CodexProjection;
  p.item({ id: "body", type: "agentMessage", text: "![image](local)" }, false);
  p.delta("body", " more", "assistant_message");
  p.item({ id: "body", type: "agentMessage", text: "![image](local) more" }, true);
  expect(events.map(event => event.metadata)).toEqual([
    { complete: false, format: "markdown", truncated: false }, { complete: false, format: "markdown", truncated: false }, { complete: true, format: "markdown", truncated: false },
  ]);
  expect(new Set(events.map(event => event.entry.entryId)).size).toBe(1);
});
test("Codex only treats actual reasoning text as Markdown", () => {
  const { events, instance } = projection("codex"), p = instance as CodexProjection;
  p.item({ id: "reason", type: "reasoning", summary: ["![image](local)"] }, true);
  p.item({ id: "raw", type: "reasoning", summary: [{ unsupported: "![image](local)" }] }, true);
  p.item({ id: "tool", type: "mcpToolCall", result: { text: "![image](local)" } }, true);
  expect(events.map(event => event.metadata)).toEqual([
    { complete: true, format: "markdown", truncated: false }, { complete: true, format: "plain", truncated: false }, { complete: true, format: "plain", truncated: false },
  ]);
});
test("Codex completes held streamed reasoning when the final item is opaque", () => {
  const { events, instance } = projection("codex"), p = instance as CodexProjection;
  p.delta("reason", "![image](local)", "reasoning");
  p.item({ id: "reason", type: "reasoning", summary: [], content: [], encryptedContent: "opaque" }, true);
  expect(events.at(-1)).toMatchObject({ entry: { kind: "reasoning", text: "![image](local)" }, metadata: { complete: true, format: "markdown", truncated: false } });
});
test("Codex exposes truncation and refuses guessed identities for multi-text native user content", () => {
  const { events, instance } = projection("codex"), p = instance as CodexProjection;
  p.item({ id: "large", type: "agentMessage", text: "a".repeat(200_001) }, true);
  p.item({ id: "user", type: "userMessage", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }, true);
  expect(events.map(event => event.metadata)).toEqual([
    { complete: true, format: "markdown", truncated: true }, { complete: true, format: "plain", truncated: false },
  ]);
});
test("Copilot distinguishes final Markdown bodies from raw tool results", () => {
  const { events, instance } = projection("copilot"), p = instance as CopilotProjection;
  p.accept({ type: "assistant.message_delta", data: { messageId: "message", deltaContent: "![image](local)" } });
  p.accept({ type: "assistant.message", data: { messageId: "message", content: "![image](local)" } });
  p.accept({ type: "assistant.reasoning", data: { reasoningId: "reason", content: "reason" } });
  p.accept({ type: "user.message", id: "user", data: { content: "user" } });
  p.accept({ type: "tool.execution_start", data: { toolCallId: "tool", toolName: "Bash" } });
  p.accept({ type: "tool.execution_complete", data: { toolCallId: "tool", success: true, result: "![image](local)" } });
  expect(events.map(event => event.metadata)).toEqual([
    { complete: false, format: "markdown", truncated: false }, { complete: true, format: "markdown", truncated: false }, { complete: true, format: "markdown", truncated: false }, { complete: true, format: "markdown", truncated: false }, { complete: false, format: "plain", truncated: false }, { complete: true, format: "plain", truncated: false },
  ]);
});
