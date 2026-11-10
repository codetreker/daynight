import { expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClaudeImageInputs } from "../../../src/commands/controller/providers/claude-image-input.js";
import type { NativeInput, ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const fixture = () => {
  const operationId = randomUUID(), sessionId = randomUUID(), image = { type: "image" as const, imageId: randomUUID(), resourceId: randomUUID(), mediaType: "image/png", byteLength: "3", sha256: "a".repeat(64), localPath: "/private/native-image" };
  const input: NativeInput = { content: [{ type: "text", text: "same text" }, image] }, state = new Map<string, unknown>();
  const intent: any = { sha256: "b".repeat(64), state: "unknown", command: { kind: "send_message", operationId, payload: { expectedTurnId: null, target: { expectedNativeSessionId: sessionId }, content: [{ type: "text", text: "same text" }, { ...image, uploadId: randomUUID() }] } } };
  const options = { imageRuntime: { getIntent: (id: string) => id === operationId ? intent : null, readState: (key: string) => state.get(key) ?? null, writeState: (key: string, value: unknown) => state.set(key, structuredClone(value)) }, onInputObserved: vi.fn(() => true) } as unknown as ProviderOptions;
  return { operationId, sessionId, image, input, intent, state, options, inputs: new ClaudeImageInputs(options, sessionId) };
};

test("Claude image dispatch persists the complete ordered original intent and rejects repeat or image steer", () => {
  const f = fixture();
  expect(() => f.inputs.prepare({ content: [...f.input.content].reverse() }, f.operationId)).toThrow("intent");
  f.inputs.prepare(f.input, f.operationId);
  expect(f.inputs.original(f.operationId)).toEqual(f.input);
  expect(() => f.inputs.prepare(f.input, f.operationId)).toThrow("already");
  const other = fixture(); other.intent.command.payload.expectedTurnId = "active";
  expect(() => other.inputs.prepare(other.input, other.operationId)).toThrow("intent");
});

test("an original UUID requires explicit root execution evidence and a durable true receipt", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId);
  expect(f.inputs.observe({ type: "user", uuid: f.operationId, session_id: f.sessionId })).toBeNull();
  expect(f.inputs.observe({ type: "assistant", user_message_uuid: f.operationId, session_id: f.sessionId, parent_tool_use_id: "subagent" })).toBeNull();
  expect(f.inputs.observe({ type: "assistant", user_message_uuid: f.operationId, session_id: "wrong", parent_tool_use_id: null })).toBeNull();
  expect(f.inputs.observe({ type: "assistant", user_message_uuid: "other", session_id: f.sessionId })).toBeNull();
  vi.mocked(f.options.onInputObserved!).mockReturnValue(false);
  expect(f.inputs.observe({ type: "assistant", user_message_uuid: f.operationId, session_id: f.sessionId })).toBeNull();
  vi.mocked(f.options.onInputObserved!).mockReturnValue(true);
  expect(f.inputs.observe({ type: "result", user_message_uuid: f.operationId, session_id: f.sessionId })).toBe(f.operationId);
  expect(f.options.onInputObserved).toHaveBeenLastCalledWith({ provider: "claude", nativeSessionId: f.sessionId, operationId: f.operationId, nativeMessageId: f.operationId, intentSha256: f.intent.sha256 });
});

test("history root ancestry supplies execution proof after cold reopen without matching by text", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId);
  const reopened = new ClaudeImageInputs(f.options, f.sessionId);
  expect(reopened.observe({ type: "user", uuid: f.operationId, parentUuid: null, session_id: f.sessionId }, true)).toBeNull();
  expect(reopened.observe({ type: "progress", uuid: "progress", parentUuid: f.operationId, session_id: f.sessionId }, true)).toBeNull();
  expect(reopened.observe({ type: "assistant", uuid: "answer", parentUuid: "progress", session_id: f.sessionId }, true)).toBe(f.operationId);
  f.intent.sha256 = "c".repeat(64);
  expect(reopened.observe({ type: "result", user_message_uuid: f.operationId, session_id: f.sessionId })).toBeNull();
});

test.each([
  { subtype: "success", is_error: false, num_turns: 0, result: "" },
  { subtype: "error_during_execution", is_error: true, num_turns: 0, errors: ["UserPromptSubmit hook blocked this request"] },
  { subtype: "success", is_error: false, num_turns: 1, result: "uncorrelated execution summary" },
])("a terminal envelope alone never proves original root image execution: %j", terminal => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId);
  expect(f.inputs.observe({ type: "result", session_id: f.sessionId, user_message_uuid: f.operationId, parent_tool_use_id: null, ...terminal })).toBeNull();
  expect(f.options.onInputObserved).not.toHaveBeenCalled();
});

test("a root execution proof survives reopening before its durable input receipt succeeds", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId);
  vi.mocked(f.options.onInputObserved!).mockReturnValue(false);
  expect(f.inputs.observe({ type: "assistant", user_message_uuid: f.operationId, session_id: f.sessionId })).toBeNull();
  const reopened = new ClaudeImageInputs(f.options, f.sessionId); vi.mocked(f.options.onInputObserved!).mockReturnValue(true);
  expect(reopened.observe({ type: "result", user_message_uuid: f.operationId, session_id: f.sessionId, num_turns: 1 })).toBe(f.operationId);
});

test.each([{ error: "authentication_failed" }, { error: "invalid_request" }, { isApiErrorMessage: true }])("a native assistant error cannot establish image execution: %j", failure => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId);
  expect(f.inputs.observe({ type: "assistant", session_id: f.sessionId, user_message_uuid: f.operationId, ...failure })).toBeNull();
  expect(f.inputs.observe({ type: "result", session_id: f.sessionId, user_message_uuid: f.operationId, num_turns: 0, is_error: true })).toBeNull();
  expect(f.options.onInputObserved).not.toHaveBeenCalled();
});
