import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { assertSessionFence, parseSessionCommand, parseSessionSnapshot } from "../../src/session/protocol.js";
import { parseControllerMessage, parseRelayMessage, parseSourceEvent } from "../../src/session/controller-protocol.js";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const testId = "11111111-1111-4111-8111-111111111111";
const testBound = (value: Record<string, unknown>) => { const { claimId: _, ...rest } = value; return { ...rest, testExecutionId: testId }; };
test("test commands retain strict exclusive execution fences", () => {
  const task = fixture("send-message"), value = testBound(task);
  expect(parseSessionCommand(value)).toEqual(value);
  expect(() => parseSessionCommand({ ...value, claimId: task.claimId })).toThrow();
  expect(() => parseSessionCommand({ ...value, claimId: null })).toThrow();
  expect(() => assertSessionFence(parseSessionCommand(task), parseSessionCommand(value))).toThrow();
});
test("only test snapshots admit not_required and owner identity", () => {
  const task = fixture("snapshot");
  const { projectId: _, taskId: __, workerId: ___, worktreeId: ____, ...common } = task.identity;
  const value = { ...testBound(task), identity: { ...common, ownerUserId: testId }, initialInputState: "not_required" };
  expect(parseSessionSnapshot(value)).toEqual(value);
  expect(() => parseSessionSnapshot({ ...task, initialInputState: "not_required" })).toThrow();
  expect(() => parseSessionSnapshot({ ...value, identity: task.identity })).toThrow();
  expect(() => parseSessionSnapshot({ ...value, identity: { ...value.identity, taskId: testId } })).toThrow();
});
test("test binding survives hello, relay frames and state source events", () => {
  const base = { protocol: "daynight.session.v1", sessionId: testId, testExecutionId: testId, executionGeneration: "1" };
  const hello = { ...base, type: "hello", schemaVersion: 1, projectionVersion: 1, controllerId: testId, controllerInstanceId: testId, provider: "codex", sourceEpoch: testId, lastAckedSourceSeq: "0" };
  expect(parseControllerMessage(hello)).toEqual(hello);
  const ack = { ...base, type: "heartbeat_ack", connectionEpoch: "1" };
  expect(parseRelayMessage(ack)).toEqual(ack);
  expect(() => parseRelayMessage({ ...ack, claimId: testId })).toThrow();
  const state = { sourceSeq: "1", kind: "state", payload: { nativeSessionId: testId, initialInputState: "not_required", synchronized: true, activity: "idle", currentTurnId: null, capabilities: { send: true, steer: true, cancel: true, respond: true } } };
  expect(parseSourceEvent(state)).toEqual(state);
});
test("none-input Test may send before Claude proves native identity, but never before readiness", () => {
  const task = fixture("snapshot");
  const { projectId: _, taskId: __, workerId: ___, worktreeId: ____, ...common } = task.identity;
  const value = { ...testBound(task), identity: { ...common, nativeSessionId: null, ownerUserId: testId }, initialInputState: "not_required", activity: "idle", currentTurnId: null, operations: { canSend: true, canCancel: false, canRespond: true } };
  expect(parseSessionSnapshot(value).operations.canSend).toBe(true);
  expect(() => parseSessionSnapshot({ ...value, activity: "initializing" })).toThrow();
  expect(() => parseSessionSnapshot({ ...value, synchronized: false })).toThrow();
  expect(() => parseSessionSnapshot({ ...value, initialInputState: "not_submitted" })).toThrow();
  expect(() => parseSessionSnapshot({ ...task, identity: { ...task.identity, nativeSessionId: null } })).toThrow();
});
test("a nested operation cannot swap a Test relay frame for a Task binding", () => {
  const task = fixture("send-message");
  expect(() => parseRelayMessage({ protocol: task.protocol, sessionId: task.sessionId, testExecutionId: testId, executionGeneration: task.executionGeneration, connectionEpoch: "1", type: "operation_offer", operationSeq: "1", command: task })).toThrow();
});
