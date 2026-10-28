import { expect, test } from "vitest";
import { nativeEntryId, CodexProjection, parseProviderArguments } from "../../../src/commands/controller/providers/projection.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";

test("Codex streaming updates the native item and completed output keeps its identity", () => {
  const entries: ProviderEntry[] = []; const project = new CodexProjection("thread", entry => entries.push(entry));
  project.item({ id: "a", type: "agentMessage", text: "" }, false);
  project.delta("a", "hello", "assistant_message");
  project.delta("a", " world", "assistant_message");
  project.item({ id: "a", type: "agentMessage", text: "hello world" }, true);
  expect(new Set(entries.map(e => e.entryId)).size).toBe(1);
  expect(entries.at(-1)).toMatchObject({ kind: "assistant_message", content: [{ type: "text", text: "hello world" }] });
  expect(nativeEntryId("thread", "a")).not.toBe(nativeEntryId("another", "a"));
});
test("tool failures, reasoning, user messages and compaction retain typed native content", () => {
  const entries: ProviderEntry[] = []; const project = new CodexProjection("thread", entry => entries.push(entry));
  project.item({ id: "tool", type: "commandExecution", command: "false", aggregatedOutput: "failed", status: "failed" }, true);
  project.item({ id: "user", type: "userMessage", content: [{ type: "text", text: "hi" }] }, true);
  project.item({ id: "reason", type: "reasoning", summary: ["checking"] }, true);
  project.item({ id: "compact", type: "contextCompaction" }, true);
  expect(entries.map(e => e.kind)).toEqual(["tool_call", "user_message", "reasoning", "compaction"]);
  expect(entries[0]).toMatchObject({ status: "failed", output: [{ type: "text", text: "failed" }] });
});
test("Codex reasoning without readable text does not emit an empty timeline row", () => {
  const entries: ProviderEntry[] = []; const project = new CodexProjection("thread", entry => entries.push(entry));
  project.item({ id: "reason", type: "reasoning", summary: [], content: [] }, false);
  project.delta("reason", "", "reasoning");
  project.delta("reason", " \n", "reasoning");
  project.item({ id: "reason", type: "reasoning", summary: [], content: [], encryptedContent: "opaque" }, true);
  expect(entries).toEqual([]);
  project.delta("reason", "checking", "reasoning");
  expect(entries).toEqual([{ entryId: nativeEntryId("thread", "reason"), revision: "1", kind: "reasoning", text: " \nchecking" }]);
});
test("an empty completed Codex reasoning item cannot erase streamed text", () => {
  const entries: ProviderEntry[] = []; const project = new CodexProjection("thread", entry => entries.push(entry));
  project.delta("reason", "checking", "reasoning");
  project.item({ id: "reason", type: "reasoning", summary: [], content: [] }, true);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ kind: "reasoning", text: "checking" });
  project.item({ id: "reason", type: "reasoning", summary: ["checking complete"] }, true);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({ entryId: nativeEntryId("thread", "reason"), kind: "reasoning", text: "checking complete" });
});
test("web native options map explicit permissions and reject unsupported TUI arguments", () => {
  expect(parseProviderArguments("codex", ["--sandbox", "read-only", "--ask-for-approval", "on-request"])).toMatchObject({ sandbox: "read-only", approvalPolicy: "on-request" });
  expect(parseProviderArguments("claude", ["--permission-mode", "default"])).toMatchObject({ permissionMode: "default" });
  expect(() => parseProviderArguments("codex", ["--resume", "latest"])).toThrow("Unsupported");
  expect(() => parseProviderArguments("claude", ["--dangerously-skip-permissions"])).toThrow("Unsupported");
});
