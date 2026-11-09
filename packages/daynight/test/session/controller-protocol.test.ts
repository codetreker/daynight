import { describe, expect, it } from "vitest";
import { parseControllerMessage, parseRegistrationRequest, parseBrowserMessage, parseRelayMessage } from "../../src/session/controller-protocol.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("relay transport", () => {
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
