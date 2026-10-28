import { describe, expect, it } from "vitest";
import { parseControllerMessage, parseRegistrationRequest, parseBrowserMessage } from "../../src/session/controller-protocol.js";
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
});
