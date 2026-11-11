import { expect, test } from "vitest";
import { CodexImageProjection } from "../../../src/commands/controller/providers/codex-image-projection.js";
import { CodexImageInputs } from "../../../src/commands/controller/providers/codex-image-input.js";
import { CodexMediaReference } from "../../../src/commands/controller/providers/codex-rpc-json.js";
import { CodexProjection } from "../../../src/commands/controller/providers/projection.js";
import type { NativeImageSlot } from "../../../src/commands/controller/providers/image-projector.js";
import type { MarkdownTimelineMetadata, ProviderEntry, ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const fixture = () => {
  const states = new Map(), publications: { entry: ProviderEntry; slots: readonly NativeImageSlot[]; metadata: MarkdownTimelineMetadata | undefined }[] = [];
  const options = { cwd: "/authorized/worktree", imageRuntime: { readState: (key: string) => states.get(key), writeState: (key: string, value: unknown) => states.set(key, structuredClone(value)) } } as unknown as ProviderOptions;
  const projection = new CodexImageProjection("thread", options, new CodexImageInputs(options, "thread"), { publish(entry, slots = [], metadata) { publications.push({ entry, slots, metadata }); } });
  return { projection, publications, options };
};
const missing = () => new CodexMediaReference("unavailable", "image/png", null, null, "image_too_large");

test("ordinary MCP and dynamic tools retain their existing arguments, output and errors", () => {
  const f = fixture(), expected: ProviderEntry[] = [], actual: ProviderEntry[] = [];
  const legacy = new CodexProjection("thread", entry => expected.push(entry));
  const projection = new CodexProjection("thread", entry => actual.push(entry), f.projection);
  for (const item of [
    { id: "failure", type: "mcpToolCall", tool: "lookup", arguments: { query: "record" }, status: "failed", result: null, error: { message: "Access denied by remote server" } },
    { id: "mcp", type: "mcpToolCall", tool: "lookup", arguments: { query: "record" }, result: { content: [{ type: "text", text: "found" }] } },
    { id: "dynamic", type: "dynamicToolCall", tool: "lookup", arguments: { query: "record" }, contentItems: [{ type: "inputText", text: "found" }], success: true },
  ]) { legacy.item(item, true, "turn"); projection.item(item, true, "turn"); }
  expect(actual).toEqual(expected);
  expect(f.publications).toEqual([]);
});

test("image tool output retains its arguments and error while later error-only completion keeps image identity", () => {
  const f = fixture();
  const item = { id: "m", type: "mcpToolCall", tool: "draw", arguments: { prompt: "triangle" }, result: { content: [{ type: "text", text: "preview" }, { type: "image", data: missing() }] } };
  f.projection.item(item, false, "turn");
  expect(f.publications[0]!.entry).toMatchObject({ input: JSON.stringify(item.arguments, null, 2) });
  f.projection.item({ ...item, arguments: undefined, result: null, status: "failed", error: { message: "Access denied by remote server" } }, true, "turn");
  expect(f.publications.at(-1)!.entry).toMatchObject({ input: JSON.stringify(item.arguments, null, 2), status: "failed", output: [{ text: "preview" }, { text: "" }, { text: "Access denied by remote server" }] });
  expect(f.publications.at(-1)!.slots.map(slot => ({ index: slot.index, native: slot.native }))).toEqual(f.publications[0]!.slots.map(slot => ({ index: slot.index, native: slot.native })));
  f.projection.item({ id: "d", type: "dynamicToolCall", tool: "draw", arguments: { shape: "circle" }, status: "failed", success: false, error: { message: "Render failed" }, contentItems: [{ type: "inputImage", imageUrl: missing() }] }, true, "turn");
  expect(f.publications.at(-1)!.entry).toMatchObject({ input: JSON.stringify({ shape: "circle" }, null, 2), status: "failed", output: [{ text: "" }, { text: "Render failed" }] });
});

test("native MCP and dynamic images keep text order and stable tool ownership without serialized media", () => {
  const f = fixture();
  f.projection.item({ id: "m", type: "mcpToolCall", server: "tools", tool: "diagram", status: "failed", result: { content: [{ type: "text", text: "before" }, { type: "image", data: missing(), mimeType: "image/png" }, { type: "text", text: "after" }] } }, true, "turn");
  const first = f.publications[0]!;
  expect(first.entry).toMatchObject({ kind: "tool_call", callId: "m", status: "failed", output: [{ text: "before" }, { text: "" }, { text: "after" }] });
  expect(first.slots).toMatchObject([{ index: 1, native: { provider: "codex", nativeSessionId: "thread", nativeMessageId: "m", nativePartId: "result/content/1" } }]);
  f.projection.item({ id: "d", type: "dynamicToolCall", tool: "draw", status: "completed", contentItems: [{ type: "inputText", text: "first" }, { type: "inputImage", imageUrl: missing() }] }, true, "turn");
  expect(f.publications[1]!.slots).toMatchObject([{ index: 1, native: { nativePartId: "contentItems/1" } }]);
  expect(JSON.stringify(f.publications.map(p => p.entry))).not.toContain("image_too_large");
});

test("fileId and unsupported tool payloads remain explicit slots without disclosing raw values", () => {
  const f = fixture();
  f.projection.item({ id: "f", type: "functionCallOutput", output: [{ type: "input_text", text: "ok" }, { type: "input_image", file_id: "private-native-file" }, { type: "input_audio", audio_url: "data:secret" }] }, true, "turn");
  expect(f.publications[0]!.slots).toMatchObject([{ index: 1, payload: { kind: "unavailable", error: { code: "native_source_unavailable" } } }]);
  expect(JSON.stringify(f.publications[0]!.entry)).not.toContain("private-native-file"); expect(JSON.stringify(f.publications[0]!.entry)).not.toContain("data:secret");
  f.projection.item({ id: "g", type: "imageGeneration", status: "completed", fileId: "native-file" }, true, "turn");
  expect(f.publications[1]!.slots).toHaveLength(1);
});

test("tool deltas and late starts retain image slots and cannot revive a terminal tool", () => {
  const f = fixture(), item = { id: "m", type: "mcpToolCall", tool: "draw", result: { content: [{ type: "text", text: "before" }, { type: "image", data: missing(), mimeType: "image/png" }] } };
  f.projection.item(item, true, "turn");
  expect(f.projection.toolDelta("m", " delta")).toBe(true);
  expect(f.publications.at(-1)!.entry).toMatchObject({ status: "completed", output: [{ text: "before delta" }, { text: "" }] });
  expect(f.publications.at(-1)!.slots).toHaveLength(1);
  expect(f.publications.at(-1)!.metadata).toEqual({ complete: true, format: "plain", truncated: false });
  f.projection.item({ ...item, result: null }, false, "turn");
  expect(f.publications.at(-1)!.entry).toMatchObject({ status: "completed" });
  expect(f.publications.at(-1)!.slots).toHaveLength(1);
  expect(f.publications.at(-1)!.metadata).toEqual({ complete: true, format: "plain", truncated: false });
});

test("mixed image tool deltas retain truncation when their terminal item omits output", () => {
  const f = fixture();
  f.projection.item({ id: "m", type: "mcpToolCall", tool: "draw", result: { content: [{ type: "image", data: missing() }] } }, false, "turn");
  f.projection.toolDelta("m", "a".repeat(200_001));
  expect(f.publications.at(-1)!.metadata).toEqual({ complete: false, format: "plain", truncated: true });
  f.projection.item({ id: "m", type: "mcpToolCall", status: "completed", result: null }, true, "turn");
  expect(f.publications.at(-1)!.entry).toMatchObject({ status: "completed", truncated: true });
  expect(f.publications.at(-1)!.metadata).toEqual({ complete: true, format: "plain", truncated: true });
  expect(f.publications.at(-1)!.slots).toHaveLength(1);
});

test("an in-progress generated image remains pending at the same source position until completion", () => {
  const f = fixture();
  f.projection.item({ id: "generated", type: "imageGeneration", status: "inProgress", result: "" }, false, "turn");
  expect(f.publications[0]!.slots[0]!.payload).toEqual({ kind: "pending" });
  f.projection.toolDelta("generated", "Rendering preview");
  expect(f.publications.at(-1)!.slots[0]!.payload).toEqual({ kind: "pending" });
  f.projection.item({ id: "generated", type: "imageGeneration", status: "completed", fileId: "unreadable" }, true, "turn");
  expect(f.publications.at(-1)!.slots[0]!.native).toEqual(f.publications[0]!.slots[0]!.native);
  expect(f.publications.at(-1)!.entry.entryId).toBe(f.publications[0]!.entry.entryId);
  expect(() => f.projection.item({ id: "generated", type: "imageGeneration", status: "completed" }, true, "other-turn")).toThrow("different turn");
});
