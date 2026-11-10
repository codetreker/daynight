import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CodexImageInputs, encodeCodexInput } from "../../../src/commands/controller/providers/codex-image-input.js";
import { CodexMediaReference } from "../../../src/commands/controller/providers/codex-rpc-json.js";
import type { NativeInput, ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const fixture = () => {
  const operationId = randomUUID(), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), localPath: "/private/native-image" };
  const input: NativeInput = { content: [{ type: "text", text: "same text" }, image] }, state = new Map<string, unknown>();
  const intent: any = { sha256: "b".repeat(64), state: "unknown", command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: null }, content: [{ type: "text", text: "same text" }, { ...image, uploadId: randomUUID() }] } } };
  const options = { imageRuntime: { getIntent: (id: string) => id === operationId ? intent : null, readState: (key: string) => state.get(key) ?? null, writeState: (key: string, value: unknown) => state.set(key, structuredClone(value)) }, onInputObserved: vi.fn(() => true) } as unknown as ProviderOptions;
  return { operationId, image, input, intent, state, options, inputs: new CodexImageInputs(options, "thread") };
};

test("Codex input uses ordered localImage blocks and omits text for a pure image message", () => {
  const f = fixture();
  expect(encodeCodexInput(f.input)).toEqual([{ type: "text", text: "same text", text_elements: [] }, { type: "localImage", path: f.image.localPath }]);
  expect(encodeCodexInput({ content: [f.image] })).toEqual([{ type: "localImage", path: f.image.localPath }]);
  expect(encodeCodexInput({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] })).toEqual([{ type: "text", text: "first\nsecond", text_elements: [] }]);
});

test("original client identity, complete ordered intent and exact native turn are all required", () => {
  const f = fixture(); f.intent.command.payload.expectedTurnId = "turn"; f.inputs.prepare(f.input, f.operationId, "turn");
  const item = { id: "live-item", type: "userMessage", clientId: f.operationId, content: encodeCodexInput(f.input) };
  expect(f.inputs.match(item, "other-turn")).toBeNull();
  expect(f.inputs.match({ ...item, clientId: "unrelated" }, "turn")).toBeNull();
  expect(f.inputs.match({ ...item, content: [...item.content].reverse() }, "turn")).toBeNull();
  const matched = f.inputs.match(item, "turn")!;
  expect(matched.operationId).toBe(f.operationId); expect(matched.originals.get(1)).toEqual({ imageId: f.image.imageId, resourceId: f.image.resourceId });
  expect(f.inputs.confirm(matched)).toBe(true);
  expect(f.options.onInputObserved).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", nativeSessionId: "thread", operationId: f.operationId, intentSha256: f.intent.sha256 }));
});

test("resumed aliases preserve canonical image identity and verify native inline bytes before reusing the original", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null);
  const first = f.inputs.match({ id: "live", type: "userMessage", clientId: f.operationId, content: encodeCodexInput(f.input) }, "turn")!;
  const resumed = new CodexImageInputs(f.options, "thread");
  const content = [{ type: "text", text: "same text" }, { type: "image", url: new CodexMediaReference("available", "image/png", 3, f.image.sha256, null) }];
  expect(resumed.match({ id: "item-0", type: "userMessage", clientId: f.operationId, content }, "turn")?.entryId).toBe(first.entryId);
  content[1] = { type: "image", url: new CodexMediaReference("available", "image/png", 3, "c".repeat(64), null) };
  expect(resumed.match({ id: "item-1", type: "userMessage", clientId: f.operationId, content }, "turn")).toBeNull();
  expect(new CodexImageInputs(f.options, "other-thread").match({ id: "item-0", type: "userMessage", clientId: f.operationId, content }, "turn")).toBeNull();
});

test("late native response evidence does not settle unless the durable callback accepts the original intent", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null);
  vi.mocked(f.options.onInputObserved!).mockReturnValue(false);
  const match = f.inputs.match({ id: "native", type: "userMessage", clientId: f.operationId, content: encodeCodexInput(f.input) }, "turn")!;
  expect(f.inputs.confirm(match)).toBe(false);
  f.intent.sha256 = "c".repeat(64);
  expect(f.inputs.match({ id: "native", type: "userMessage", clientId: f.operationId, content: encodeCodexInput(f.input) }, "turn")).toBeNull();
});
