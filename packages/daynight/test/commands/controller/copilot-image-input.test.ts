import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { CopilotImageInputs } from "../../../src/commands/controller/providers/copilot-image-input.js";
import type { NativeInput, ProviderOptions } from "../../../src/commands/controller/providers/types.js";
import { nativeEntryId } from "../../../src/commands/controller/providers/projection.js";
import type { NativeInputPublicationRequest } from "../../../src/commands/controller/media/native-publication-types.js";

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

const publication = (f: ReturnType<typeof fixture>) => {
  const nativeSource = { provider: "copilot" as const, nativeSessionId: f.sessionId, nativeMessageId: f.messageId, nativePartId: "attachment/0" };
  return { raw: f.event, seed: { entry: { kind: "user_message" as const, entryId: nativeEntryId(f.sessionId, `:user:${f.messageId}`), content: [{ type: "text" as const, text: "same" }, { type: "image_unavailable" as const, imageId: randomUUID(), label: "Native image", error: { code: "capture_pending", message: "Pending" } }] }, nativeSlots: [{ index: 1, nativeSource, label: "Native image" }] }, originals: [{ imageId: f.image.imageId, resourceId: f.image.resourceId, nativeSlotIndex: 1, appendNativeSource: { ...nativeSource, nativePartId: "original/0" } }] };
};

test("an unknown publication only queries its original identity and retains intent across reopen", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); const match = f.inputs.accept(f.operationId, f.messageId), intent = publication(f);
  const unknown = { state: "unknown" as const, error: { code: "publication_unknown" as const, message: "Lost commit response" } };
  const query = vi.fn().mockReturnValueOnce({ state: "absent" }).mockReturnValue(unknown), publish = vi.fn((_request: NativeInputPublicationRequest) => unknown);
  Object.assign(f.options.imageRuntime!, { publishNativeInputAssociation: publish, queryNativeInputAssociation: query });
  expect(f.inputs.associate(match, intent)).toEqual(unknown); expect(publish).toHaveBeenCalledOnce();
  const identity = publish.mock.calls[0]![0].identity;
  const reopened = new CopilotImageInputs(f.options, f.sessionId); reopened.restoreAccepted();
  expect(reopened.associate(match, intent)).toEqual(unknown);
  expect(publish).toHaveBeenCalledOnce(); expect(query).toHaveBeenLastCalledWith(identity);
  reopened.finishTurn(); expect(reopened.profileAllowed).toBe(true); expect(reopened.pendingAccepted()).toHaveLength(1);
});

test("a lost publication call is not replayed until the original query proves absence", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); const match = f.inputs.accept(f.operationId, f.messageId), intent = publication(f);
  const query = vi.fn().mockReturnValueOnce({ state: "absent" }).mockImplementationOnce(() => { throw new Error("Journal unreadable"); }).mockReturnValue({ state: "absent" });
  const publish = vi.fn().mockImplementationOnce(() => { throw new Error("Commit outcome lost"); }).mockReturnValue({ state: "not_committed", error: { code: "publication_unavailable", message: "Original missing" } });
  Object.assign(f.options.imageRuntime!, { publishNativeInputAssociation: publish, queryNativeInputAssociation: query });
  expect(f.inputs.associate(match, intent)).toMatchObject({ state: "unknown" });
  expect(f.inputs.associate(match, intent)).toMatchObject({ state: "unknown" }); expect(publish).toHaveBeenCalledOnce();
  expect(f.inputs.associate(match, intent)).toMatchObject({ state: "not_committed" }); expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[1]).toEqual(publish.mock.calls[0]);
});

test("a legacy provider publication is recovery intent and cannot stand in for the shared receipt", () => {
  const f = fixture(); f.inputs.prepare(f.input, f.operationId, null); const match = f.inputs.accept(f.operationId, f.messageId), intent = publication(f);
  const saved = [...f.state.entries()].find(([key]) => key.startsWith("copilot:input:"))!;
  f.state.set(saved[0], { ...saved[1] as object, publication: { nativeEventId: f.messageId, raw: f.event, entry: intent.seed.entry, slots: [] } });
  const query = vi.fn(() => ({ state: "absent" })), publish = vi.fn(() => ({ state: "unknown", error: { code: "publication_unknown", message: "Lost" } }));
  Object.assign(f.options.imageRuntime!, { publishNativeInputAssociation: publish, queryNativeInputAssociation: query });
  expect(f.inputs.publication(f.messageId)).toEqual({ state: "absent" }); expect(f.inputs.pendingAccepted()).toHaveLength(1);
  expect(f.inputs.associate(match, intent)).toMatchObject({ state: "unknown" }); expect(publish).toHaveBeenCalledOnce();
  expect(f.inputs.publicationIntent(f.messageId)?.request.originals).toEqual(intent.originals);
});
