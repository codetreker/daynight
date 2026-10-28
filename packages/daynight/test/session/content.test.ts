import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInteractionResponse, parseSessionEvent, parseSessionInteraction, parseSessionOperation, parseSessionResource, parseSessionSnapshot, parseTimelineEntry } from "../../src/session/protocol.js";
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const entry = { entryId: "00000012-1111-4111-8111-111111111111", entrySeq: "1", revision: "1" };
const interaction = { interactionId: "00000011-1111-4111-8111-111111111111", revision: "1", state: "pending", title: "Choose" };
const choices = [{ id: "one", label: "First" }];
const approval = { ...interaction, kind: "approval", detail: "Run tests", actions: ["allow_once", "reject"] };
const question = { ...interaction, kind: "question", canDismiss: true, questions: [{ questionId: "q1", label: "Which?", options: choices, multiple: true, allowCustom: true, required: true, sensitive: false }] };
const form = { ...interaction, kind: "form", canDismiss: true, fields: [
  { fieldId: "name", label: "Name", required: true, type: "text", sensitive: true },
  { fieldId: "count", label: "Count", required: true, type: "number", min: 0, max: 10 },
  { fieldId: "ok", label: "OK", required: false, type: "boolean" },
  { fieldId: "option", label: "Option", required: false, type: "select", options: choices },
  { fieldId: "many", label: "Many", required: false, type: "multiselect", options: choices },
] };

describe("typed session content", () => {
  it.each([approval, question, form])("round trips structured interaction $kind", (value) => expect(parseSessionInteraction(value)).toEqual(value));
  it.each([
    { kind: "question", answers: [{ questionId: "q1", optionIds: ["one"], text: "Other context" }] },
    { kind: "form", values: [{ fieldId: "name", value: "Name" }, { fieldId: "count", value: 3 }, { fieldId: "ok", value: true }, { fieldId: "many", value: ["one"] }] },
    { kind: "dismiss" },
  ])("retains structured response $kind", (value) => expect(parseInteractionResponse(value)).toEqual(value));
  it.each([
    { ...entry, kind: "user_message", content: [{ type: "text", text: "Hello" }] },
    { ...entry, kind: "reasoning", text: "Consider identity." },
    { ...entry, kind: "tool_call", callId: "call-1", name: "shell", input: '{"command":"pnpm test"}', output: [{ type: "text", text: "PASS" }], status: "completed", truncated: false },
    { ...entry, kind: "interaction", interaction: approval },
    { ...entry, kind: "error", code: "provider_error", message: "Provider failed." },
    { ...entry, kind: "compaction", summary: "Earlier context summarized." },
    { ...entry, kind: "todo", items: [{ id: "t1", text: "Verify", status: "completed" }] },
  ])("retains timeline entry $kind", (value) => expect(parseTimelineEntry(value)).toEqual(value));
  it.each([
    { ...question, questions: [{ ...question.questions[0], options: [...choices, ...choices] }] },
    { ...question, questions: [{ ...question.questions[0], options: [], allowCustom: false }] },
    { ...question, questions: [...question.questions, ...question.questions] },
    { ...form, fields: [{ ...form.fields[1], min: 10, max: 1 }] },
    { ...form, fields: [{ ...form.fields[0], type: "executable" }] },
    { ...form, fields: [...form.fields, ...form.fields] },
    { ...approval, actions: ["allow_once", "allow_once"] },
    { ...approval, actions: [] },
    { ...approval, revision: 1 },
    { ...approval, state: "answered" },
    { ...approval, kind: "custom" },
    null,
  ])("rejects malformed or ambiguous interactions %#", (value) => expect(() => parseSessionInteraction(value)).toThrow());
  it.each([
    { kind: "question", answers: [{ questionId: "q1", optionIds: ["one", "one"], text: null }] },
    { kind: "form", values: [{ fieldId: "count", value: Infinity }] },
    { kind: "form", values: [{ fieldId: "x", value: null }] },
    { kind: "dismiss", action: "approve" },
    { kind: "arbitrary" }, null,
  ])("rejects invalid responses %#", (value) => expect(() => parseInteractionResponse(value)).toThrow());
  it.each([
    { ...entry, kind: "assistant_message", content: [{ type: "html", text: "<script>" }] },
    { ...entry, kind: "assistant_message", content: [{ type: "resource", resourceId: "bad", label: "File" }] },
    { ...entry, kind: "assistant_message", content: [null] },
    { ...entry, kind: "assistant_message", content: [{ type: "text", text: "\ud800" }] },
    { ...entry, kind: "reasoning", text: "a\0b" },
    { ...entry, kind: "todo", items: [{ id: "t1", text: "a", status: "pending" }, { id: "t1", text: "b", status: "pending" }] },
    { ...entry, kind: "raw_native" }, null,
  ])("rejects invalid timeline content %#", (value) => expect(() => parseTimelineEntry(value)).toThrow());
  it("keeps lifecycle, provider capabilities and initial acceptance distinct", () => {
    const value = fixture("snapshot");
    for (const patch of [{ initialInputState: "unknown" }, { synchronized: false }, { lifecycle: "archived" }, { connectionState: "disconnected" }, { activity: "working", currentTurnId: null }, { identity: { ...(value.identity as object), nativeSessionId: null } }, { capabilities: { send: false, steer: false, cancel: false, respond: false } }]) {
      expect(() => parseSessionSnapshot({ ...value, ...patch })).toThrow();
    }
    const working = { ...value, activity: "working", currentTurnId: "turn-1", capabilities: { send: true, steer: false, cancel: true, respond: true } };
    expect(() => parseSessionSnapshot(working)).toThrow();
    expect(parseSessionSnapshot({ ...working, operations: { canSend: false, canCancel: true, canRespond: true } }).operations.canCancel).toBe(true);
    expect(() => parseSessionSnapshot({ ...value, operations: { canSend: false, canCancel: true, canRespond: false } })).toThrow();
    expect(() => parseSessionSnapshot({ ...value, capabilities: { send: true, steer: false, cancel: true, respond: false }, operations: { canSend: false, canCancel: false, canRespond: true } })).toThrow();
  });
  it("preserves event variants while rejecting conflicting nested fences", () => {
    const envelope = fixture("event");
    for (const [kind, payload] of [["snapshot", fixture("snapshot")], ["operation", fixture("operation")], ["resource", fixture("resource")], ["gap", { reason: "source_reset", cursor: null }]] as const) {
      expect(parseSessionEvent({ ...envelope, kind, payload })).toEqual({ ...envelope, kind, payload });
    }
    expect(() => parseSessionEvent({ ...envelope, kind: "snapshot", payload: { ...fixture("snapshot"), connectionEpoch: "4" } })).toThrow();
    expect(() => parseSessionEvent({ ...envelope, kind: "snapshot", payload: { ...fixture("snapshot"), historyEpoch: "another" } })).toThrow();
    expect(() => parseSessionEvent({ ...envelope, kind: "operation", payload: { ...fixture("operation"), executionGeneration: "2" } })).toThrow();
  });
  it("preserves unavailable resource metadata without claiming usable bytes", () => {
    const value = { ...fixture("resource"), status: "unavailable", mediaType: null, byteLength: null, sha256: null, error: "The source is unavailable." };
    expect(parseSessionResource(value)).toEqual(value);
    expect(() => parseSessionResource({ ...value, status: "available" })).toThrow();
    expect(() => parseSessionResource({ ...fixture("resource"), mediaType: "text/plain\r\nX: value" })).toThrow();
  });
  it("preserves explicit native failure and zero cursors", () => {
    const value = { ...fixture("operation"), state: "failed", providerResult: null, error: { code: "native_failed", message: "The provider rejected the input." } };
    expect(parseSessionOperation(value)).toEqual(value);
    const snapshot = { ...fixture("snapshot"), lastEventSeq: "0", lastTimelineSeq: "0" };
    expect(parseSessionSnapshot(snapshot)).toEqual(snapshot);
  });
});
