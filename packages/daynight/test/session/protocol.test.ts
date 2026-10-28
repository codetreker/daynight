import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseSessionCommand, parseSessionEvent, parseSessionOperation, parseSessionResource,
  parseSessionSnapshot, assertSessionFence,
} from "../../src/session/protocol.js";

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

describe("session wire contract", () => {
  it("represents registration before any controller connection without granting writes", () => {
    const snapshot = { ...fixture("snapshot"), connectionEpoch: "0", connectionState: "disconnected", operations: { canSend: false, canCancel: false, canRespond: false } };
    expect(parseSessionSnapshot(snapshot).connectionEpoch).toBe("0");
    expect(() => parseSessionSnapshot({ ...snapshot, connectionState: "connected" })).toThrow();
    const saved = parseSessionSnapshot(snapshot);
    expect(parseSessionEvent({ protocol: saved.protocol, sessionId: saved.sessionId, claimId: saved.claimId, executionGeneration: saved.executionGeneration, connectionEpoch: "0", historyEpoch: saved.historyEpoch, eventSeq: "1", kind: "snapshot", payload: saved }).connectionEpoch).toBe("0");
  });
  it.each(["send-message", "cancel", "interaction-response"])("round trips the shared %s fixture", (name) => {
    const value = fixture(name);
    expect(JSON.parse(JSON.stringify(parseSessionCommand(value)))).toEqual(value);
  });
  it("preserves int64 decimal fences without number rounding", () => {
    const value = parseSessionCommand(fixture("send-message"));
    expect(value.executionGeneration).toBe("9007199254740993");
    assertSessionFence(value, value);
    if (value.claimId === undefined) throw new Error("Expected task fixture.");
    expect(() => assertSessionFence(value, { ...value, executionGeneration: "9007199254740994" })).toThrow("fence");
    expect(() => assertSessionFence(value, { ...value, claimId: "00000001-1111-4111-8111-111111111111" })).toThrow("fence");
  });
  it.each([undefined, null, 1, 9007199254740993, "0", "-1", "01", "1.0", "1e3", "9223372036854775808"])("rejects invalid execution fences %j", (executionGeneration) => {
    expect(() => parseSessionCommand({ ...fixture("send-message"), executionGeneration })).toThrow();
  });
  it.each(["daynight.session.v2", null, undefined, ""])("rejects unknown protocol versions %j", (protocol) => {
    expect(() => parseSessionCommand({ ...fixture("send-message"), protocol })).toThrow();
  });
  it("rejects extra fields, invalid IDs and missing turn fences", () => {
    expect(() => parseSessionCommand({ ...fixture("send-message"), extra: true })).toThrow();
    expect(() => parseSessionCommand({ ...fixture("send-message"), sessionId: "native-thread-1" })).toThrow();
    expect(() => parseSessionCommand({ ...fixture("cancel"), payload: { expectedTurnId: null } })).toThrow();
    expect(() => parseSessionCommand({ ...fixture("send-message"), payload: { content: [{ type: "text", text: "hello" }] } })).toThrow();
  });
  it("does not introduce resource uploads or queue fallback into send", () => {
    const command = fixture("send-message");
    expect(() => parseSessionCommand({ ...command, payload: { expectedTurnId: null, content: [{ type: "resource", resourceId: "00000013-1111-4111-8111-111111111111", label: "file" }] } })).toThrow();
    expect(() => parseSessionCommand({ ...command, payload: { expectedTurnId: null, content: [{ type: "text", text: "  " }] } })).toThrow();
    expect(() => parseSessionCommand({ ...command, payload: { expectedTurnId: null, content: [{ type: "text", text: "hello" }], delivery: "next_turn" } })).toThrow();
  });
  it("bounds UTF-8 input and rejects invalid text without stripping user content", () => {
    const value = fixture("send-message");
    const payload = (text: string) => ({ expectedTurnId: null, content: [{ type: "text", text }] });
    for (const text of ["\u0000", "\ud800", "界".repeat(350_000)]) {
      expect(() => parseSessionCommand({ ...value, payload: payload(text) })).toThrow();
    }
    expect(parseSessionCommand({ ...value, payload: payload("\uFEFF") }).kind).toBe("send_message");
    expect(() => parseSessionCommand({ ...value, payload: { expectedTurnId: null, content: Array.from({ length: 1001 }, () => ({ type: "text", text: "a" })) } })).toThrow();
  });
  it("requires exact current interaction identity and typed response", () => {
    const value = fixture("interaction-response"), payload = value.payload as Record<string, unknown>;
    for (const patch of [{ interactionRevision: "0" }, { submissionId: null }, { response: { kind: "approval", action: "allow_everything" } }]) {
      expect(() => parseSessionCommand({ ...value, payload: { ...payload, ...patch } })).toThrow();
    }
  });
  it("round trips snapshot, event, receipt and resource fixtures", () => {
    for (const [name, parse] of [["snapshot", parseSessionSnapshot], ["event", parseSessionEvent], ["operation", parseSessionOperation], ["resource", parseSessionResource]] as const) {
      const value = fixture(name);
      expect(JSON.parse(JSON.stringify(parse(value)))).toEqual(value);
    }
  });
  it("requires initial input state and strict snapshot schema versions", () => {
    const value = fixture("snapshot");
    for (const patch of [{ initialInputState: undefined }, { initialInputState: "ready" }, { schemaVersion: 2 }, { projectionVersion: 0 }, { connectionEpoch: 0 }]) {
      expect(() => parseSessionSnapshot({ ...value, ...patch })).toThrow();
    }
    for (const initialInputState of ["not_submitted", "dispatching", "provider_accepted", "confirmed", "failed", "unknown"]) {
      expect(parseSessionSnapshot({ ...value, initialInputState, operations: { canSend: false, canCancel: false, canRespond: true } }).initialInputState).toBe(initialInputState);
    }
  });
  it("separates connection fencing from native execution fencing", () => {
    const value = parseSessionSnapshot(fixture("snapshot"));
    expect(() => assertSessionFence(value, { ...value, connectionEpoch: "4" })).toThrow("fence");
  });
  it("rejects unknown event kinds and malformed resource locators", () => {
    expect(() => parseSessionEvent({ ...fixture("event"), kind: "raw_native" })).toThrow();
    expect(() => parseSessionResource({ ...fixture("resource"), path: "/etc/passwd" })).toThrow();
    expect(() => parseSessionResource({ ...fixture("resource"), sha256: "bad" })).toThrow();
    expect(() => parseSessionResource({ ...fixture("resource"), byteLength: 9007199254740993 })).toThrow();
  });
  it("retains unknown operations without implying failure or acceptance", () => {
    const value = { ...fixture("operation"), state: "unknown", providerResult: null };
    expect(parseSessionOperation(value).state).toBe("unknown");
    expect(() => parseSessionOperation({ ...value, state: "done" })).toThrow();
  });
});


it("preserves Copilot capability gates without assuming native steer", () => {
  const original = parseSessionSnapshot(fixture("snapshot"));
  const value = { ...original, identity: { ...original.identity, provider: "copilot" }, activity: "working", currentTurnId: "native-turn", capabilities: { ...original.capabilities, steer: false }, operations: { ...original.operations, canSend: false } };
  expect(parseSessionSnapshot(value).identity.provider).toBe("copilot");
  expect(() => parseSessionSnapshot({ ...value, operations: { ...value.operations, canSend: true } })).toThrow();
  expect(parseSessionSnapshot({ ...value, activity: "idle", currentTurnId: null, operations: { ...value.operations, canSend: true, canCancel: false } }).operations.canSend).toBe(true);
});
