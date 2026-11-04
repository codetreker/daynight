import { expect, test } from "vitest";
import { providerDisplayEntry } from "../../../src/commands/controller/provider-display.js";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import { CopilotProjection } from "../../../src/commands/controller/providers/copilot-projection.js";
import type { ProviderEntry } from "../../../src/commands/controller/providers/types.js";
import { parseSourceEvent } from "../../../src/session/controller-protocol.js";
import { parseSessionCommand } from "../../../src/session/protocol.js";
import { sessionDisplayEntry, sessionWireBytes } from "../../../src/commands/controller/wire-display.js";

const base = { entryId: "11111111-1111-4111-8111-111111111111", revision: "1" };
const prefix = "[Escaped display: NUL and unpaired UTF-16 surrogates use \\uXXXX; original backslashes are doubled]\n";
const suffix = "\n[Output truncated at 200000 characters]";
const literal = (body: string) => prefix + "\n```\n" + body + "\n```";
const source = (entry: ProviderEntry) => ({ sourceSeq: "1", kind: "timeline_upsert", payload: entry });
const reasoning = (text: string): ProviderEntry => ({ ...base, kind: "reasoning", text });
const display = (text: string): string => {
  const entry = providerDisplayEntry({ ...base, kind: "compaction", summary: text });
  if (entry.kind !== "compaction") throw new Error("Expected compaction");
  return entry.summary;
};

test.each(["", "中文 😀\n\ttext", "literal \\u0000 and \\ud800", "a".repeat(200_000)])("ordinary well-formed display text remains unchanged (%#)", text => {
  expect(display(text)).toBe(text);
});

test.each([
  ["a\0b", "a\\u0000b"],
  ["a\ud800b", "a\\ud800b"],
  ["a\udfffb", "a\\udfffb"],
  ["\ud800\ud801\udc00\udfff", "\\ud800\ud801\udc00\\udfff"],
  ["中文 😀\n\t\0\\u0000", "中文 😀\n\t\\u0000\\\\u0000"],
] as const)("illegal display characters use distinguishable visible escapes (%#)", (input, expected) => {
  const result = display(input);
  expect(result).toBe(prefix + expected);
  expect(result.isWellFormed()).toBe(true);
  expect(result).not.toContain("\0");
  expect(display(result)).toBe(result);
  expect(() => parseSourceEvent(source(reasoning(result)))).not.toThrow();
  expect(() => parseSourceEvent(source(reasoning(input)))).toThrow("Invalid Daynight session protocol value.");
});

test("the display whitelist copies text while retaining authority and resource fields", () => {
  const text = "before\0after", escaped = prefix + "before\\u0000after";
  const resource = { type: "resource" as const, resourceId: "22222222-2222-4222-8222-222222222222", label: "resource" };
  const entries: ProviderEntry[] = [
    { ...base, kind: "user_message", content: [{ type: "text", text }, resource] },
    { ...base, kind: "assistant_message", content: [{ type: "text", text }, resource] },
    reasoning(text),
    { ...base, kind: "tool_call", callId: "native-call", name: "tool", input: text, output: [{ type: "text", text }, resource], status: "completed", truncated: false },
    { ...base, kind: "error", code: "native_error", message: text },
    { ...base, kind: "compaction", summary: text },
    { ...base, kind: "todo", items: [{ id: "todo-1", text, status: "in_progress" }] },
  ];
  const originals = structuredClone(entries);
  const converted = entries.map(providerDisplayEntry);
  expect(entries).toEqual(originals);
  expect(converted).toEqual([
    { ...base, kind: "user_message", content: [{ type: "text", text: literal("before\\u0000after") }, resource] },
    { ...base, kind: "assistant_message", content: [{ type: "text", text: literal("before\\u0000after") }, resource] },
    reasoning(literal("before\\u0000after")),
    { ...base, kind: "tool_call", callId: "native-call", name: "tool", input: escaped, output: [{ type: "text", text: escaped }, resource], status: "completed", truncated: false },
    { ...base, kind: "error", code: "native_error", message: escaped },
    { ...base, kind: "compaction", summary: escaped },
    { ...base, kind: "todo", items: [{ id: "todo-1", text: escaped, status: "in_progress" }] },
  ]);
  for (const entry of converted) expect(() => parseSourceEvent(source(entry))).not.toThrow();
});

test("interaction and invalid authority fields are not repaired by display conversion", () => {
  const interaction: ProviderEntry = { ...base, kind: "interaction", interaction: { interactionId: base.entryId, revision: "1", state: "pending", kind: "approval", title: "bad\0title", detail: "bad\ud800detail", actions: ["allow_once"] } };
  expect(providerDisplayEntry(interaction)).toBe(interaction);
  const entries: ProviderEntry[] = [
    interaction,
    { ...reasoning("body\0"), entryId: "bad\0id" },
    { ...base, kind: "tool_call", callId: "bad\0id", name: "tool", input: "body\0", output: [], status: "running", truncated: false },
    { ...base, kind: "tool_call", callId: "call", name: "bad\0name", input: "body\0", output: [], status: "running", truncated: false },
    { ...base, kind: "error", code: "bad\0code", message: "body\0" },
    { ...base, kind: "todo", items: [{ id: "bad\0id", text: "body\0", status: "pending" }] },
    { ...base, kind: "assistant_message", content: [{ type: "resource", resourceId: base.entryId, label: "bad\0label" }] },
  ];
  for (const entry of entries) expect(() => parseSourceEvent(source(providerDisplayEntry(entry)))).toThrow();
});

test.each(["\0", "\ud800", "\udfff"])("operation input and interaction responses still reject illegal text (%#)", illegal => {
  const command = { protocol: "daynight.session.v1", sessionId: base.entryId, claimId: base.entryId, executionGeneration: "1", requestId: base.entryId, operationId: base.entryId };
  const commands = (text: string) => [
    { ...command, kind: "send_message", payload: { expectedTurnId: null, content: [{ type: "text", text }] } },
    { ...command, kind: "execute_command", payload: { commandId: "native-command", arguments: text, expectedControlsRevision: "1", expectedTurnId: null } },
    { ...command, kind: "interaction_response", payload: { interactionId: base.entryId, interactionRevision: "1", submissionId: base.entryId, response: { kind: "question", answers: [{ questionId: "question", optionIds: [], text }] } } },
    { ...command, kind: "interaction_response", payload: { interactionId: base.entryId, interactionRevision: "1", submissionId: base.entryId, response: { kind: "form", values: [{ fieldId: "field", value: text }] } } },
  ];
  for (const value of commands("valid 中文 😀")) expect(() => parseSessionCommand(value)).not.toThrow();
  expect(() => parseSourceEvent(source(providerDisplayEntry(reasoning(illegal))))).not.toThrow();
  for (const value of commands(illegal)) expect(() => parseSessionCommand(value)).toThrow("Invalid Daynight session protocol value.");
});

test("multiple converted parts retain the whole-entry wire fallback without replacing local content", () => {
  const rawText = "\0" + "\u0001".repeat(120_000);
  const entry: ProviderEntry = { ...base, kind: "assistant_message", content: [{ type: "text", text: rawText }, { type: "text", text: rawText }] };
  const converted = providerDisplayEntry(entry), saved = JSON.stringify(converted);
  expect(() => parseSourceEvent(source(converted))).not.toThrow();
  expect(sessionWireBytes(converted)).toBeGreaterThan(1_400_000);
  const fallback = sessionDisplayEntry(converted);
  expect(fallback).toMatchObject({ ...base, kind: "error", code: "display_budget_exceeded" });
  expect(sessionWireBytes(fallback)).toBeLessThan(1_400_000);
  expect(() => parseSourceEvent(source(fallback))).not.toThrow();
  expect(JSON.stringify(converted) === saved).toBe(true);
  expect(entry.content[0]?.type === "text" && entry.content[0].text === rawText).toBe(true);
});

test("synthetic command output with 15455 NULs retains all 20580 original characters visibly", () => {
  const input = "x".repeat(5125) + "\0".repeat(15455);
  expect(input.length).toBe(20580);
  expect(display(input) === prefix + "x".repeat(5125) + "\\u0000".repeat(15455)).toBe(true);
});

test.each(["\0", "\ud800", "\udfff"])("dense illegal content stays inside character, byte and wire budgets (%#)", character => {
  const result = display(character.repeat(200_000));
  expect(result.startsWith(prefix)).toBe(true);
  expect(result.endsWith(suffix)).toBe(true);
  const body = result.slice(prefix.length, -suffix.length);
  expect(body).toMatch(/^(?:\\u[0-9a-f]{4})+$/);
  expect(result.length).toBeLessThanOrEqual(200_000 + suffix.length);
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1_048_576);
  expect(sessionWireBytes(reasoning(result))).toBeLessThan(1_400_000);
  expect(() => parseSourceEvent(source(reasoning(result)))).not.toThrow();
  expect(display(result)).toBe(result);
});

test.each(["中", "\u2028", "\u0001"])("converted multibyte and JSON-escaped text respects decoded and serialized limits (%#)", character => {
  const result = display("\0" + character.repeat(200_000));
  expect(result.endsWith(suffix)).toBe(true);
  expect(result.length).toBeLessThanOrEqual(200_000 + suffix.length);
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(1_048_576);
  expect(sessionWireBytes(reasoning(result))).toBeLessThan(1_400_000);
  expect(() => parseSourceEvent(source(reasoning(result)))).not.toThrow();
});

test.each(["😀", "\0", "\ud800", "\\"])("truncation retains complete Unicode and escape tokens (%#)", token => {
  const capacity = 200_000 - prefix.length - 6;
  const before = "\0" + "a".repeat(capacity - 1);
  const result = display(before + token + "tail");
  expect(result === prefix + "\\u0000" + "a".repeat(capacity - 1) + suffix).toBe(true);
  expect(result.isWellFormed()).toBe(true);
});

test("a final complete escape fitting the budget is retained without a false truncation marker", () => {
  const result = display("a".repeat(200_000 - prefix.length - 6) + "\0");
  expect(result.length).toBe(200_000);
  expect(result.endsWith("\\u0000")).toBe(true);
  expect(result).not.toContain(suffix);
});

test.each(["😀", "\0", "\ud800", "\\"])("Markdown framing participates in Unicode and escape boundary truncation (%#)", token => {
  const capacity = 200_000 - prefix.length - 9 - 6;
  const entry = providerDisplayEntry(reasoning("\0" + "a".repeat(capacity - 1) + token + "tail"));
  if (entry.kind !== "reasoning") throw new Error("Expected reasoning");
  expect(entry.text === literal("\\u0000" + "a".repeat(capacity - 1) + suffix)).toBe(true);
  expect(entry.text.length).toBeLessThanOrEqual(200_000 + suffix.length);
  expect(entry.text.isWellFormed()).toBe(true);
  expect(providerDisplayEntry(entry)).toEqual(entry);
});

test.each([
  ["\0\n```\ntext\n~~~", "````"],
  ["\0\n``````\ntext\n~~~", "~~~~"],
  ["\0\n``\ntext\n~~~~~~", "```"],
] as const)("Markdown fences exceed embedded delimiter runs (%#)", (input, fence) => {
  const entry = providerDisplayEntry(reasoning(input));
  if (entry.kind !== "reasoning") throw new Error("Expected reasoning");
  expect(entry.text).toBe(prefix + `\n${fence}\n` + input.replace("\0", "\\u0000") + `\n${fence}`);
  expect(providerDisplayEntry(entry)).toEqual(entry);
});

test.each(["input", "output"] as const)("tool truncation includes new %s truncation and preserves prior truncation", field => {
  const tool: ProviderEntry = { ...base, kind: "tool_call", callId: "call", name: "tool", input: field === "input" ? "\0".repeat(200_000) : "input", output: [{ type: "text", text: field === "output" ? "\0".repeat(200_000) : "output" }], status: "completed", truncated: false };
  expect(providerDisplayEntry(tool)).toMatchObject({ kind: "tool_call", status: "completed", truncated: true });
  expect(tool.truncated).toBe(false);
  expect(providerDisplayEntry({ ...tool, input: "\0", output: [], truncated: true })).toMatchObject({ truncated: true });
});

const bodyText = (entry: ProviderEntry): string => {
  if (entry.kind === "reasoning") return entry.text;
  const parts = entry.kind === "tool_call" ? entry.output : entry.kind === "assistant_message" ? entry.content : [];
  return parts.map(part => part.type === "text" ? part.text : "").join("");
};

test.each(["assistant_message", "reasoning", "tool_call"] as const)("Codex %s split-surrogate deltas retain raw accumulation and stable identity", kind => {
  const raw: ProviderEntry[] = [], shown: ProviderEntry[] = [];
  const projection = new CodexProjection("native-session", entry => { raw.push(entry); shown.push(providerDisplayEntry(entry)); });
  if (kind === "tool_call") {
    projection.item({ id: "item", type: "commandExecution", command: "run", aggregatedOutput: "" }, false);
    projection.toolDelta("item", "\ud83d"); projection.toolDelta("item", "\ude00");
    projection.toolDelta("item", "\0\\u0000");
  } else {
    projection.delta("item", "\ud83d", kind); projection.delta("item", "\ude00", kind);
    projection.delta("item", "\0\\u0000", kind);
  }
  const split = shown.slice(-3);
  const escaped = kind === "tool_call" ? (text: string) => prefix + text : literal;
  expect(split.map(bodyText)).toEqual([escaped("\\ud83d"), "😀", escaped("😀\\u0000\\\\u0000")]);
  expect(new Set(split.map(entry => entry.entryId)).size).toBe(1);
  expect(bodyText(raw.at(-1)!)).toBe("😀\0\\u0000");
  for (const entry of shown) expect(() => parseSourceEvent(source(entry))).not.toThrow();
});

test.each(["message", "reasoning", "tool"] as const)("Copilot %s split-surrogate deltas retain raw accumulation and stable identity", kind => {
  const raw: ProviderEntry[] = [], shown: ProviderEntry[] = [];
  const projection = new CopilotProjection("native-session", entry => { raw.push(entry); shown.push(providerDisplayEntry(entry)); });
  if (kind === "tool") projection.accept({ type: "tool.execution_start", data: { toolCallId: "item", toolName: "tool", arguments: "input" } });
  for (const delta of ["\ud83d", "\ude00", "\0\\u0000"]) {
    projection.accept(kind === "tool" ? { type: "tool.execution_partial_result", data: { toolCallId: "item", partialOutput: delta } } : { type: `assistant.${kind}_delta`, data: { messageId: "item", reasoningId: "item", deltaContent: delta } });
  }
  const split = shown.slice(-3);
  const escaped = kind === "tool" ? (text: string) => prefix + text : literal;
  expect(split.map(bodyText)).toEqual([escaped("\\ud83d"), "😀", escaped("😀\\u0000\\\\u0000")]);
  expect(new Set(split.map(entry => entry.entryId)).size).toBe(1);
  expect(bodyText(raw.at(-1)!)).toBe("😀\0\\u0000");
  for (const entry of shown) expect(() => parseSourceEvent(source(entry))).not.toThrow();
});
