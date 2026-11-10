import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { CopilotImageInputs } from "../../../src/commands/controller/providers/copilot-image-input.js";
import type { NativeInput, ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const fixture = () => {
  const operationId = randomUUID(), sessionId = randomUUID(), messageId = randomUUID();
  const image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), localPath: "/private/image" };
  const input: NativeInput = { content: [{ type: "text", text: "same" }, image] }, state = new Map<string, unknown>();
  const intent: any = { sha256: "b".repeat(64), state: "unknown", command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: sessionId }, content: [{ type: "text", text: "same" }, { ...image, uploadId: randomUUID() }] } } };
  const observed = vi.fn(() => true);
  const options = { imageRuntime: { getIntent: (id: string) => id === operationId ? intent : null, readState: (key: string) => state.get(key) ?? null, writeState: (key: string, value: unknown) => state.set(key, structuredClone(value)) }, onInputObserved: observed } as unknown as ProviderOptions;
  const event = { type: "user.message", id: messageId, data: { content: "same", attachments: [{ type: "blob", mimeType: "image/png" }] } };
  return { operationId, sessionId, messageId, input, image, intent, state, observed, options, event, inputs: new CopilotImageInputs(options, sessionId) };
};
test("only the original Promise receipt can establish durable Copilot acceptance", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null);
  expect(f.inputs.match(f.event)).toBeNull(); expect(f.observed).not.toHaveBeenCalled();
  expect(f.inputs.accept(f.operationId, f.messageId).images).toEqual([f.image]);
  expect(f.observed).toHaveBeenCalledWith({ provider: "copilot", nativeSessionId: f.sessionId, operationId: f.operationId, nativeMessageId: f.messageId, intentSha256: f.intent.sha256 });
  expect(f.inputs.match(f.event)?.operationId).toBe(f.operationId);
  expect(f.inputs.match({ ...f.event, id: randomUUID() })).toBeNull();
  expect(f.inputs.match({ ...f.event, agentId: "child" })).toBeNull();
  expect(() => new CopilotImageInputs(f.options, f.sessionId).prepare(f.input, f.operationId, null)).toThrow("already been dispatched");
});
test("an empty receipt or failed durable callback preserves unknown without a fabricated event alias", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null);
  expect(() => f.inputs.accept(f.operationId, "")).toThrow("unknown");
  f.observed.mockReturnValue(false); expect(() => f.inputs.accept(f.operationId, f.messageId)).toThrow("durably");
  expect(f.inputs.match(f.event)).toBeNull();
});
test("a matching receipt still requires the complete native content shape and main-agent ownership", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  expect(f.inputs.match({ ...f.event, data: { ...f.event.data, attachments: [] } })).toBeNull();
  expect(f.inputs.profileAllowed).toBe(false);
  f.intent.sha256 = "c".repeat(64); expect(f.inputs.match(f.event)).toBeNull();
});
test("changed ordered intent is rejected before recording dispatch", () => {
  const f = fixture();
  expect(() => f.inputs.prepare({ content: [f.image] }, f.operationId, null)).toThrow("complete authorized intent");
  expect(f.state.size).toBe(0);
});

test("an accepted receipt without an exact user-event identity disables the profile at the native turn boundary", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  expect(f.inputs.match({ ...f.event, id: randomUUID() })).toBeNull();
  const reopened = new CopilotImageInputs(f.options, f.sessionId); reopened.restoreAccepted(); reopened.finishTurn();
  expect(f.inputs.profileAllowed).toBe(false); expect(f.observed).toHaveBeenCalledTimes(2);
  expect(f.inputs.pendingAccepted()).toMatchObject([{ operationId: f.operationId, messageId: f.messageId }]);
});

test("matching an event alone does not publish an alias before its durable publication plan", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); f.inputs.accept(f.operationId, f.messageId);
  expect(f.inputs.match(f.event)).not.toBeNull(); f.inputs.finishTurn();
  expect(f.inputs.profileAllowed).toBe(false); expect(f.inputs.pendingAccepted()).toHaveLength(1);
});
