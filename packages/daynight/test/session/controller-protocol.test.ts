import { describe, expect, it } from "vitest";
import { parseControllerMessage, parseRegistrationRequest, parseBrowserMessage, parseRelayMessage } from "../../src/session/controller-protocol.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("relay transport", () => {
  it("retains distinct effective and provider image revisions only in an explicit authorization", () => {
    const frame = { type: "operation_authorized", protocol: "daynight.session.v1", sessionId: id, claimId: id, executionGeneration: "2", connectionEpoch: "3", operationId: id };
    const imageAuthorization = { revision: "7", providerRevision: "2", expectedNativeSessionId: "native", modelId: "model", controlsRevision: "3", send: "supported", steer: "unsupported", reasonCode: null, inputMediaTypes: ["image/png"], maxImageBytes: "100", maxMessageImageBytes: "200", maxImagesPerMessage: 2, geometry: { version: 1, known: true, maxWidth: 32, maxHeight: 32, maxPixels: 1024, maxFrames: 1 } };
    expect(parseRelayMessage(frame)).toEqual(frame);
    expect(parseRelayMessage({ ...frame, imageAuthorization })).toEqual({ ...frame, imageAuthorization });
    for (const invalid of [null, { ...imageAuthorization, providerRevision: undefined }, { ...imageAuthorization, revision: "0" }, { ...imageAuthorization, geometry: { ...imageAuthorization.geometry, known: false } }]) expect(() => parseRelayMessage({ ...frame, imageAuthorization: invalid })).toThrow();
  });
  it.each(["codex", "claude", "copilot"])("requires exact %s registration identity", (provider) => {
    const request = { protocol: "daynight.session.v1", registrationId: id, claimId: id, workerId: id, worktreeId: id, provider, controllerId: id, controllerInstanceId: id };
    expect(parseRegistrationRequest(request)).toEqual(request);
    const hello = { type: "hello", protocol: "daynight.session.v1", schemaVersion: 1, projectionVersion: 1, sessionId: id, claimId: id, executionGeneration: "1", controllerId: id, controllerInstanceId: id, provider, sourceEpoch: id, lastAckedSourceSeq: "0" };
    expect(parseControllerMessage(hello)).toEqual(hello);
    expect(() => parseRegistrationRequest({ ...request, executionGeneration: "2" })).toThrow();
  });
  it("keeps source ordering independent from server sequence numbers", () => {
    const message = { type: "events", protocol: "daynight.session.v1", sessionId: id, claimId: id, executionGeneration: "9007199254740993", connectionEpoch: "1", sourceEpoch: id, batchId: id, events: [{ sourceSeq: "1", kind: "gap", payload: { reason: "Native history unavailable" } }] };
    expect(parseControllerMessage(message)).toEqual(message);
    expect(() => parseControllerMessage({ ...message, eventSeq: "1" })).toThrow();
    expect(() => parseControllerMessage({ ...message, connectionEpoch: "0" })).toThrow();
    expect(() => parseControllerMessage({ ...message, events: [] })).toThrow();
  });
  it("rejects invented browser channel variants", () => {
    expect(parseBrowserMessage({ type: "reset_required", protocol: "daynight.session.v1", reason: "Cursor belongs to another projection" }).type).toBe("reset_required");
    expect(() => parseBrowserMessage({ type: "take_control", protocol: "daynight.session.v1" })).toThrow();
  });
  it.each(["rejected", "expired"])("reconciles an explicit %s journal receipt", (state) => {
    expect(parseControllerMessage({ type: "reconcile", protocol: "daynight.session.v1", sessionId: id, claimId: id, executionGeneration: "2", connectionEpoch: "3", final: true, operations: [{ operationId: id, state, providerResult: null, error: null }] }).type).toBe("reconcile");
  });
  it.each(["claimId", "testExecutionId"] as const)("retains historical generations only within the same %s reconciliation binding", (binding) => {
    const current = { protocol: "daynight.session.v1", sessionId: id, [binding]: id, executionGeneration: "9007199254740993", connectionEpoch: "3" };
    const operation = { protocol: current.protocol, sessionId: id, [binding]: id, executionGeneration: "9007199254740992", operationId: id, kind: "send_message", state: "rejected", providerResult: null, error: null };
    const frame = { ...current, type: "reconcile_result", operations: [operation] };
    expect(parseRelayMessage(frame)).toEqual(frame);
    expect(parseRelayMessage({ ...frame, operations: [{ ...operation, executionGeneration: current.executionGeneration }] }).type).toBe("reconcile_result");
    for (const changed of [{ sessionId: "00000000-0000-4000-8000-000000000002" }, { [binding]: "00000000-0000-4000-8000-000000000002" }, { executionGeneration: "9007199254740994" }, { executionGeneration: "0" }]) {
      expect(() => parseRelayMessage({ ...frame, operations: [{ ...operation, ...changed }] })).toThrow();
    }
    const { [binding]: _binding, ...unbound } = operation;
    const otherBinding = binding === "claimId" ? "testExecutionId" : "claimId";
    expect(() => parseRelayMessage({ ...frame, operations: [{ ...unbound, [otherBinding]: id }] })).toThrow();
    expect(() => parseRelayMessage({ ...current, type: "receipt_ack", operation })).toThrow();
    expect(() => parseControllerMessage({ ...current, type: "operation_receipt", operation })).toThrow();
  });

});

it("validates online content messages, bounded resource chunks and live synchronization", () => {
  const fence = { protocol: "daynight.session.v1", sessionId: id, claimId: id, executionGeneration: "1", connectionEpoch: "1" };
  const request = { ...fence, type: "content_request", requestId: id, kind: "timeline", historyEpoch: id, direction: "tail", cursor: null, limit: 100 };
  expect(parseRelayMessage(request)).toEqual(request);
  expect(() => parseRelayMessage({ ...request, limit: 201 })).toThrow();
  const response = { ...fence, type: "content_response", requestId: id, sourceThrough: "0", result: { kind: "timeline", historyEpoch: id, items: [], resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false }, error: null };
  expect(parseControllerMessage(response)).toEqual(response);
  expect(() => parseControllerMessage({ ...response, error: { code: "offline", message: "Offline" } })).toThrow();
  expect(parseRelayMessage({ ...fence, type: "sync_ack" })).toEqual({ ...fence, type: "sync_ack" });
});

it("keeps inspection pages and entry chunks separate from the existing display protocol", () => {
  const fence = { protocol: "daynight.session.v1", sessionId: id, claimId: id, executionGeneration: "1", connectionEpoch: "1" };
  const pageRequest = { ...fence, type: "content_request", requestId: id, kind: "inspect_page", historyEpoch: id, cursor: null, limit: 20, responseOverhead: 4096 };
  expect(parseRelayMessage(pageRequest)).toEqual(pageRequest);
  for (const change of [{ limit: 201 }, { responseOverhead: 262144 }, { direction: "tail" }]) expect(() => parseRelayMessage({ ...pageRequest, ...change })).toThrow();
  const entry = { entryId: id, entrySeq: "1", revision: "1", kind: "reasoning", text: "original" };
  const page = { kind: "inspect_page", historyEpoch: id, items: [{ entryId: id, entrySeq: "1", revision: "1", kind: "reasoning", role: null, timestamp: null, body: entry, truncated: false, contentRef: null, resources: [], resourcesTruncated: false }], beforeCursor: null, hasMoreBefore: false, coverage: { state: "partial", reason: "resource_unavailable" } };
  const response = { ...fence, type: "content_response", requestId: id, sourceThrough: "1", result: page, error: null };
  expect(parseControllerMessage(response)).toEqual(response);
  expect(() => parseControllerMessage({ ...response, result: { ...page, items: [{ ...page.items[0], truncated: true }] } })).toThrow();
  expect(() => parseControllerMessage({ ...response, result: { ...page, items: [{ ...page.items[0], body: { ...entry, entryId: "00000000-0000-4000-8000-000000000002" } }] } })).toThrow();
  const cursor = "a".repeat(700);
  const chunkRequest = { ...fence, type: "content_request", requestId: id, kind: "entry_chunk", historyEpoch: id, cursor, limit: 32768 };
  expect(parseRelayMessage(chunkRequest)).toEqual(chunkRequest);
  expect(() => parseRelayMessage({ ...chunkRequest, limit: 32769 })).toThrow();
  const chunk = { kind: "entry_chunk", historyEpoch: id, entryId: id, revision: "1", sha256: "a".repeat(64), byteLength: "6", offset: "0", fragment: "原文", nextCursor: null, eof: true };
  expect(parseControllerMessage({ ...response, result: chunk })).toEqual({ ...response, result: chunk });
  for (const change of [{ fragment: "😀".repeat(8193) }, { fragment: "\ud800" }, { eof: false }, { byteLength: "5" }, { offset: "7" }]) expect(() => parseControllerMessage({ ...response, result: { ...chunk, ...change } })).toThrow();
});
