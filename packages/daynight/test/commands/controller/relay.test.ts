import { test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import snapshot from "../../session/fixtures/snapshot.json" with { type: "json" };
import type { ControllerLifecycleStore, ControllerOperation } from "../../../src/commands/controller/lifecycle-store.js";
import type { ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
const files = vi.hoisted(() => ({ readFile: vi.fn(), lstat: vi.fn() }));
vi.mock("node:fs/promises", () => files);
const transport = vi.hoisted(() => ({ sockets: [] as EventEmitter[] }));
vi.mock("ws", () => ({ default: class extends EventEmitter {
  static OPEN = 1; readyState = 1; sent: unknown[] = [];
  constructor() { super(); transport.sockets.push(this); queueMicrotask(() => this.emit("open")); }
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit("close"); }
  terminate() { this.close(); }
} }));
import { createControllerRelay, publicOperation } from "../../../src/commands/controller/relay.js";
import { RELAY_LIMITS } from "../../../src/session/controller-protocol.js";
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(close => close()); transport.sockets.length = 0; vi.clearAllMocks(); });
const setup = async (operations: ControllerOperation[] = []) => {
  const ticket = { ...snapshot.identity, ...snapshot, provider: "codex", controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, executionId: randomUUID(), credentialFile: "/private/grant", serverOrigin: "http://127.0.0.1:19000" } as unknown as ControllerLaunchTicket;
  files.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 100, mode: 0o600 });
  files.readFile.mockResolvedValue(JSON.stringify({ token: "private-token", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }));
  const journal = { acknowledgeEvents: vi.fn(), drainProjectionGap: vi.fn(), getLastAcknowledgedSequence: () => "8", pendingEvents: () => [], markOperationAcknowledged: vi.fn(), listUnacknowledgedOperations: (limit: number, after?: string) => operations.slice(after ? operations.findIndex(o => o.operationId === after) + 1 : 0, (after ? operations.findIndex(o => o.operationId === after) + 1 : 0) + limit) } as unknown as ControllerLifecycleStore;
  const callbacks = { onConnection: vi.fn(), onCommand: vi.fn().mockResolvedValue(undefined), onError: vi.fn() };
  const relay = createControllerRelay(ticket, journal, callbacks); cleanup.push(relay.close);
  await vi.waitFor(() => expect(transport.sockets.length).toBe(1));
  const socket = transport.sockets[0]! as EventEmitter & { sent: Record<string, unknown>[]; close(): void };
  const frame = (type: string, extra = {}) => ({ protocol: snapshot.protocol, sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, connectionEpoch: "3", type, ...extra });
  const emit = (value: unknown) => socket.emit("message", Buffer.from(JSON.stringify(value)));
  emit({ type: "welcome", protocol: snapshot.protocol, connectionEpoch: "3", session: snapshot, lastAckedSourceSeq: "8", limits: RELAY_LIMITS });
  return { relay, journal, callbacks, ticket, socket, emit, frame };
};

test("reconciliation waits for all bounded pages and retains unknown without native dispatch", async () => {
  const operations = Array.from({ length: 205 }, (_, i) => ({ operationId: randomUUID(), kind: "send_message", state: i === 0 ? "unknown" : "confirmed", result: null, error: null } as ControllerOperation));
  const { relay, socket, emit, frame, callbacks } = await setup(operations);
  const pages = () => socket.sent.filter(m => m.type === "reconcile");
  expect(pages()[0]).toMatchObject({ final: false, operations: expect.arrayContaining([expect.objectContaining({ state: "unknown" })]) });
  expect((pages()[0]!.operations as unknown[])).toHaveLength(100); expect(relay.connected()).toBe(false);
  emit(frame("reconcile_result", { operations: [] })); expect((pages()[1]!.operations as unknown[])).toHaveLength(100); expect(relay.connected()).toBe(false);
  emit(frame("reconcile_result", { operations: [] })); expect(pages()[2]).toMatchObject({ final: true }); expect((pages()[2]!.operations as unknown[])).toHaveLength(5);
  emit(frame("reconcile_result", { operations: [] })); expect(relay.connected()).toBe(true); expect(callbacks.onCommand).not.toHaveBeenCalled();
});

test("disconnect rejects an outstanding authorization and never treats begin as permission to invoke native", async () => {
  const { relay, socket, emit, frame } = await setup();
  emit(frame("reconcile_result", { operations: [] }));
  const pending = relay.authorize(randomUUID()); const assertion = expect(pending).rejects.toThrow("disconnected");
  socket.close(); await assertion; expect(relay.connected()).toBe(false);
});

test("old generation receipts retain their identity and only reconcile, while explicit rejected states survive", async () => {
  const operation = { operationId: randomUUID(), executionGeneration: "1", kind: "cancel", state: "rejected", result: null, error: "Native turn changed" } as ControllerOperation;
  const { relay, socket, emit, frame, ticket } = await setup([operation]);
  expect(socket.sent.find(m => m.type === "reconcile")).toMatchObject({ operations: [{ operationId: operation.operationId, state: "rejected", providerResult: null, error: { code: "native_operation_error", message: "Native turn changed" } }] });
  expect(publicOperation(ticket, operation).executionGeneration).toBe("1");
  emit(frame("reconcile_result", { operations: [] })); relay.receipt(operation);
  expect(socket.sent.some(m => m.type === "operation_receipt")).toBe(false);
});

test("closing while the credential read is pending cannot create a socket or access the released journal", async () => {
  const ticket = { ...snapshot, controllerId: snapshot.identity.controllerId, controllerInstanceId: snapshot.identity.controllerInstanceId, credentialFile: "/private/grant", serverOrigin: "http://127.0.0.1:19000" } as unknown as ControllerLaunchTicket;
  files.lstat.mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false, size: 100, mode: 0o600 });
  let finish!: (value: string) => void;
  files.readFile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const getLastAcknowledgedSequence = vi.fn(() => "0");
  const relay = createControllerRelay(ticket, { getLastAcknowledgedSequence } as unknown as ControllerLifecycleStore, { onConnection: () => {}, onCommand: async () => {}, onError: () => {} });
  cleanup.push(relay.close);
  await vi.waitFor(() => expect(files.readFile).toHaveBeenCalledOnce()); relay.close();
  finish(JSON.stringify({ token: "token", expiresAt: new Date(Date.now() + 60_000).toISOString(), sessionId: ticket.sessionId, claimId: ticket.claimId, executionGeneration: ticket.executionGeneration, controllerId: ticket.controllerId, controllerInstanceId: ticket.controllerInstanceId }));
  await new Promise(resolve => setImmediate(resolve));
  expect(transport.sockets).toHaveLength(0); expect(getLastAcknowledgedSequence).not.toHaveBeenCalled();
});
