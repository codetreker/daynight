import { afterEach, expect, test, vi } from "vitest";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHerdrInputArbiter, type HerdrInputArbiter } from "../../../src/commands/worker/herdr/input-arbiter.js";
import { openHerdrInputStore } from "../../../src/commands/worker/herdr/input-store.js";
import WebSocket, { WebSocketServer } from "ws";
import registrationFixture from "../../session/fixtures/v2/valid-registration.json" with { type: "json" };
import dispatchFixture from "../../session/fixtures/v2/valid-control-dispatch.json" with { type: "json" };
import snapshotFixture from "../../session/fixtures/v2/valid-snapshot.json" with { type: "json" };
import operationFixture from "../../session/fixtures/v2/valid-keys.json" with { type: "json" };
import type { SessionV2Message, SessionV2Payloads } from "../../../src/session/v2/types.js";
import type { HerdrLifecycleRecord } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { HerdrSessionApi, HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import { createHerdrInputSession } from "../../../src/commands/worker/herdr/input-session.js";

type Message<K extends SessionV2Message["type"]> = Extract<SessionV2Message, { type: K }>;
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const setup = async (configure?: (registration: Message<"registration">, record: HerdrLifecycleRecord) => void) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  cleanup.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Expected TCP.");
  const registration = structuredClone(registrationFixture) as Message<"registration">;
  registration.payload.owner.serverOrigin = `http://127.0.0.1:${address.port}`;
  registration.payload.capabilities = { observe: false, control: false, archive: false };
  const segmentId = "00000000-0000-4000-8000-000000000009";
  const record: HerdrLifecycleRecord = { owner: registration.payload.owner, claimId: registration.claimId, cwd: "/isolated", sessionId: registration.sessionId, registrationId: registration.payload.registrationId, connectionEpoch: null, registrationRequest: registration, ledgerRequest: null, publishedLedgerHash: null, controlEpoch: "0", initialAssignment: "pending", initialPrompt: "assignment", automationBlocked: false, preparation: null, version: 1,
    runs: [{ run: { executionGeneration: "1", owner: registration.payload.owner, binding: registration.payload.binding, startedAt: "2026-11-04T00:00:00.000Z", stoppedAt: null, stopProof: null, segmentIds: [segmentId] }, phase: "active", nativeLaunch: "observed", instanceDirectory: "/isolated/herdr", daemon: null, processes: [], stopOperationId: null, stopReason: null, error: null, admission: null }],
    segments: [{ segmentId, segmentOrdinal: "1", executionGeneration: "1", binding: registration.payload.binding, startedAt: "2026-11-04T00:00:00.000Z", endedAt: null, durationMs: null, gap: null }] };
  configure?.(registration, record);
  const connectionEpoch = String(BigInt(registration.payload.connectionEpoch ?? "0") + 1n);
  let controlState: SessionV2Payloads["control_state"] = { connectionEpoch, controlEpoch: "1", state: "automation", lease: null, initialAssignment: "transport_completed", availableActions: ["acquire_control"], unavailableReason: null };
  let remote: HerdrSessionState = { status: "registered", protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: registration.sessionId, claimId: registration.claimId, executionGeneration: registration.executionGeneration, agentControlMode: "herdr", contentKind: "terminal_recording", owner: registration.payload.owner, binding: registration.payload.binding, connectionEpoch, connected: true, capabilities: registration.payload.capabilities, control: null, snapshot: null, ledger: { runs: record.runs.map(row => row.run), finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: [] };
  let suspended = 0, inputCalls = 0, stateFailure = false, suspendFailure = false;
  let arbiter: HerdrInputArbiter | undefined;
  const errors: Error[] = [];
  let stateWait: Promise<void> | null = null;
  const api = { state: async () => { if (stateFailure) throw new Error("offline"); const snapshot = remote; await stateWait; return snapshot; } } as Pick<HerdrSessionApi, "state">;
  let handleControl: Parameters<typeof createHerdrInputSession>[0]["control"] = async () => { throw new Error("Unexpected control."); };
  const session = createHerdrInputSession({ serverToken: "isolated", getRecord: () => record, state: () => arbiter?.state() ?? controlState, suspend: () => { arbiter?.suspend(); if (suspendFailure) throw new Error("Input journal unavailable"); suspended++; controlState = { ...controlState, state: "suspended", lease: null, controlEpoch: String(BigInt(controlState.controlEpoch) + 1n) }; }, onError: (_owner, error) => { errors.push(error); }, api: () => api,
    control: (...args) => handleControl(...args), input: async (_owner, message) => { inputCalls++; return { operationId: message.payload.operationId, state: "transport_completed", errorCode: null }; } });
  cleanup.push(() => session.close());
  const connected = once(server, "connection"); const pending = session.register(registration); void pending.catch(() => {});
  const [socket] = await connected as [WebSocket]; const incoming: SessionV2Message[] = [];
  socket.on("message", bytes => { incoming.push(JSON.parse(bytes.toString()) as SessionV2Message); });
  await vi.waitFor(() => expect(incoming).toHaveLength(1));
  const ack = { ...registration, type: "registration_ack", payload: { registrationId: registration.payload.registrationId, connectionEpoch } };
  socket.send(JSON.stringify(ack)); await pending;
  const activate = () => { record.connectionEpoch = connectionEpoch; record.registrationRequest = null; session.activate(record.sessionId); };
  return { session, socket, incoming, record, registration, activate, errors, useArbiter: (value: HerdrInputArbiter) => { arbiter = value; }, waitState: (wait: Promise<void>) => { stateWait = wait; }, failSuspend: () => { suspendFailure = true; }, getLocal: () => controlState, setControl: (handler: typeof handleControl) => { handleControl = handler; }, count: () => ({ suspended, inputCalls }), failState: () => { stateFailure = true; }, setRemote: (value: Partial<HerdrSessionState>) => { remote = { ...remote, ...value }; }, setLocal: (value: Partial<SessionV2Payloads["control_state"]>) => { controlState = { ...controlState, ...value }; } };
};

test("only activates the bridge after lifecycle registration commits", async () => {
  const f = await setup(); expect(() => f.session.activate(f.record.sessionId)).toThrow();
  f.socket.send(JSON.stringify(operationFixture));
  await new Promise(resolve => setImmediate(resolve)); expect(f.count().inputCalls).toBe(0);
  f.activate(); await vi.waitFor(() => expect(f.count().inputCalls).toBe(1));
  await vi.waitFor(() => expect(f.incoming.some(message => message.type === "operation_result")).toBe(true));
});

test("publishes only an active segment's state and does not enable capabilities", async () => {
  const f = await setup(); f.activate();
  await f.session.poll(f.record.sessionId);
  await vi.waitFor(() => expect(f.incoming.filter(message => message.type === "control_state")).toHaveLength(1));
  expect(f.registration.payload.capabilities).toEqual({ observe: false, control: false, archive: false });
  f.record.segments[0]!.endedAt = "2026-11-04T00:00:01.000Z";
  await f.session.poll(f.record.sessionId);
  expect(f.incoming.filter(message => message.type === "control_state")).toHaveLength(1);
});

test("a service read failure suspends automation and closes the connection", async () => {
  const f = await setup(); f.activate(); f.failState();
  await f.session.poll(f.record.sessionId);
  expect(f.count().suspended).toBe(1); expect(f.session.connected(f.record.sessionId)).toBe(false);
});

test("a different service connection epoch cannot retain manual input", async () => {
  const f = await setup(); f.activate(); f.setRemote({ connectionEpoch: "2" });
  await f.session.poll(f.record.sessionId);
  expect(f.count().suspended).toBe(1); expect(f.session.connected(f.record.sessionId)).toBe(false);
});

test("service-side lease removal suspends the local manual writer", async () => {
  const f = await setup(); f.activate();
  f.setLocal({ state: "manual", lease: { leaseId: "00000000-0000-4000-8000-000000000011", holderUserId: f.record.owner.ownerUserId, browserClientId: "00000000-0000-4000-8000-000000000012", controlEpoch: "1", expiresAt: "2099-01-01T00:00:00.000Z" } });
  await f.session.poll(f.record.sessionId);
  expect(f.count().suspended).toBe(1); expect(f.session.connected(f.record.sessionId)).toBe(true);
});

test("disconnect suspends automation even when no manual lease was held", async () => {
  const f = await setup(); f.activate(); f.socket.terminate();
  await vi.waitFor(() => expect(f.count().suspended).toBe(1));
  expect(f.session.connected(f.record.sessionId)).toBe(false);
});

test.each(["close", "socket", "poll"] as const)("reports failed durable suspension without escaping the %s callback", async source => {
  const f = await setup(); f.activate(); f.failSuspend();
  if (source === "close") expect(() => f.session.close(f.record.sessionId)).not.toThrow();
  else if (source === "socket") f.socket.terminate();
  else { f.failState(); await expect(f.session.poll(f.record.sessionId)).resolves.toBeUndefined(); }
  await vi.waitFor(() => expect(f.errors).toHaveLength(1));
  expect(f.errors[0]!.message).toBe("Input journal unavailable");
  expect(f.count().suspended).toBe(0); expect(f.getLocal().state).toBe("automation");
  expect(f.session.connected(f.record.sessionId)).toBe(false);
});

test("reports failed durable suspension when a control acknowledgement timer expires", async () => {
  const f = await setup(); f.activate(); f.failSuspend();
  f.setControl(async (_owner, message) => ({ requestDigest: message.payload.requestDigest, durable: true, controlState: f.getLocal(), result: { operationId: message.payload.request.operationId, state: "rejected", errorCode: "input_busy" } }));
  vi.useFakeTimers();
  try {
    f.socket.send(JSON.stringify(dispatchFixture));
    await vi.waitFor(() => expect(f.incoming.some(message => message.type === "control_ack")).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.errors).toHaveLength(1); expect(f.count().suspended).toBe(0);
    expect(f.session.connected(f.record.sessionId)).toBe(false);
  } finally { vi.useRealTimers(); }
});


test("a correlated busy refusal does not suspend automatic input", async () => {
  const f = await setup(); f.activate();
  f.setControl(async (_owner, message) => ({ requestDigest: message.payload.requestDigest, durable: true, controlState: f.getLocal(), result: { operationId: message.payload.request.operationId, state: "rejected", errorCode: "input_busy" } }));
  f.socket.send(JSON.stringify(dispatchFixture));
  await vi.waitFor(() => expect(f.incoming.some(message => message.type === "control_ack")).toBe(true));
  f.socket.send(JSON.stringify({ ...dispatchFixture, type: "operation_result", payload: { operationId: dispatchFixture.payload.request.operationId, state: "rejected", errorCode: "input_busy" } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.count().suspended).toBe(0); expect(f.session.connected(f.record.sessionId)).toBe(true);
});

test("a pending durable handback acknowledgement is not replaced by an old service state", async () => {
  const f = await setup(); f.activate();
  f.setRemote({ control: { ...f.getLocal(), state: "suspended" } });
  f.setControl(async (_owner, message) => ({ requestDigest: message.payload.requestDigest, durable: true, controlState: f.getLocal(), result: { operationId: message.payload.request.operationId, state: "transport_completed", errorCode: null } }));
  f.socket.send(JSON.stringify(dispatchFixture));
  await vi.waitFor(() => expect(f.incoming.some(message => message.type === "control_ack")).toBe(true));
  await f.session.poll(f.record.sessionId);
  expect(f.count().suspended).toBe(0);
  expect(f.incoming.filter(message => message.type === "control_state")).toHaveLength(0);
});

const recoveryPrepare = (f: Awaited<ReturnType<typeof setup>>) => ({ ...f.registration, type: "automation_recovery_prepare" as const, payload: { recoveryId: "00000000-0000-4000-8000-000000000030", connectionEpoch: "1", controlEpoch: "1", closingControlEpoch: "2", stopOperationId: "00000000-0000-4000-8000-000000000031", binding: { ...f.registration.payload.binding, nativeSessionId: "00000000-0000-4000-8000-000000000032" }, initialAssignment: "transport_completed" as const } });

test("holds periodic reconciliation during one persisted recovery decision", async () => {
  const f = await setup(); f.activate();
  f.record.runs[0]!.run.binding.nativeSessionId = "00000000-0000-4000-8000-000000000032";
  f.setRemote({ control: { ...f.getLocal(), state: "closing", availableActions: [] } });
  const release = f.session.holdRecovery(f.record.sessionId, recoveryPrepare(f));
  await f.session.poll(f.record.sessionId);
  expect(f.count().suspended).toBe(0); expect(f.session.connected(f.record.sessionId)).toBe(true);
  expect(() => f.session.holdRecovery(f.record.sessionId, recoveryPrepare(f))).toThrow();
  release(); await f.session.poll(f.record.sessionId);
  expect(f.count().suspended).toBe(1); expect(f.session.connected(f.record.sessionId)).toBe(false);
});

test("a recovery hold never masks original connection loss", async () => {
  const f = await setup(); f.activate();
  f.record.runs[0]!.run.binding.nativeSessionId = "00000000-0000-4000-8000-000000000032";
  const release = f.session.holdRecovery(f.record.sessionId, recoveryPrepare(f));
  f.socket.terminate(); await vi.waitFor(() => expect(f.count().suspended).toBe(1));
  expect(f.session.connected(f.record.sessionId)).toBe(false); release();
});

test("rejects a recovery hold from another stop identity or execution fence", async () => {
  const f = await setup(); f.activate();
  f.record.runs[0]!.run.binding.nativeSessionId = "00000000-0000-4000-8000-000000000032";
  const request = recoveryPrepare(f);
  expect(() => f.session.holdRecovery(f.record.sessionId, { ...request, claimId: "00000000-0000-4000-8000-000000000099" })).toThrow();
  expect(() => f.session.holdRecovery(f.record.sessionId, { ...request, executionGeneration: "2" })).toThrow();
  expect(f.count().suspended).toBe(0);
});

test("discards a state read that overlaps an entire recovery hold", async () => {
  const f = await setup(); f.activate();
  f.record.runs[0]!.run.binding.nativeSessionId = "00000000-0000-4000-8000-000000000032";
  f.setRemote({ control: { ...f.getLocal(), state: "suspended" } });
  let resolve!: () => void; f.waitState(new Promise<void>(done => { resolve = done; }));
  const oldPoll = f.session.poll(f.record.sessionId);
  const release = f.session.holdRecovery(f.record.sessionId, recoveryPrepare(f));
  f.setRemote({ control: f.getLocal() }); release(); resolve(); await oldPoll;
  expect(f.count().suspended).toBe(0);
  expect(f.incoming.filter(message => message.type === "control_state")).toHaveLength(0);
});

test("a new native input offer closes a recovery-held channel without dispatching", async () => {
  const f = await setup(); f.activate();
  f.record.runs[0]!.run.binding.nativeSessionId = "00000000-0000-4000-8000-000000000032";
  f.session.holdRecovery(f.record.sessionId, recoveryPrepare(f));
  f.socket.send(JSON.stringify(operationFixture));
  await vi.waitFor(() => expect(f.count().suspended).toBe(1));
  expect(f.count().inputCalls).toBe(0); expect(f.session.connected(f.record.sessionId)).toBe(false);
});

test("an unconfirmed recovery hold expires and closes input without releasing automation", async () => {
  const f = await setup(); f.activate();
  f.record.runs[0]!.run.binding.nativeSessionId = "00000000-0000-4000-8000-000000000032";
  vi.useFakeTimers();
  try {
    f.session.holdRecovery(f.record.sessionId, recoveryPrepare(f));
    await vi.advanceTimersByTimeAsync(24_999); expect(f.count().suspended).toBe(0);
    await vi.advanceTimersByTimeAsync(1); expect(f.count().suspended).toBe(1);
    expect(f.session.connected(f.record.sessionId)).toBe(false);
  } finally { vi.useRealTimers(); }
});

test("holds an adjacent successor only for the exact original shutdown proof", async () => {
  const nativeSessionId = "00000000-0000-4000-8000-000000000032", stopOperationId = "00000000-0000-4000-8000-000000000031";
  const f = await setup((registration, record) => {
    const current = record.runs[0]!; current.run.binding.nativeSessionId = nativeSessionId;
    const source = structuredClone(current); source.phase = "stopped_confirmed"; source.stopReason = "shutdown"; source.stopOperationId = stopOperationId;
    source.run.stoppedAt = "2026-11-04T00:00:01.000Z";
    source.run.stopProof = { recordId: stopOperationId, executionGeneration: "1", binding: source.run.binding, bootId: "boot", stoppedAt: source.run.stoppedAt, method: "instances_exited", terminalStopped: true, processes: [{ role: "shell", pid: 1, birthToken: "shell", bootId: "boot" }, { role: "agent", pid: 2, birthToken: "agent", bootId: "boot" }] };
    registration.executionGeneration = "2"; registration.payload.mode = "reconnect"; registration.payload.connectionEpoch = "1"; record.connectionEpoch = "1";
    current.run.executionGeneration = "2"; current.run.binding.instanceId = "new-daemon"; current.run.binding.terminalId = "new-terminal";
    record.segments[0]!.executionGeneration = "2"; record.runs.unshift(source);
  });
  f.activate();
  const prepare = { ...recoveryPrepare(f), executionGeneration: "1", payload: { ...recoveryPrepare(f).payload, binding: f.record.runs[0]!.run.binding } };
  const release = f.session.holdRecovery(f.record.sessionId, prepare); release();
  f.record.runs[0]!.run.stopProof!.recordId = "00000000-0000-4000-8000-000000000099";
  expect(() => f.session.holdRecovery(f.record.sessionId, prepare)).toThrow();
});

test("holds a durable closing state before the shutdown intent is available", async () => {
  const f = await setup(); f.activate();
  expect(() => f.session.holdShutdown(f.record.sessionId)).toThrow();
  f.setLocal({ state: "closing", controlEpoch: "2", availableActions: [] });
  expect(f.record.runs[0]!.stopOperationId).toBeNull();
  const release = f.session.holdShutdown(f.record.sessionId);
  await f.session.poll(f.record.sessionId);
  expect(f.incoming.filter(message => message.type === "control_state")).toHaveLength(0);
  expect(f.session.connected(f.record.sessionId)).toBe(true); release();
});

test("discards a closing-state poll crossing an entire shutdown hold", async () => {
  const f = await setup(); f.activate(); f.setLocal({ state: "closing", controlEpoch: "2", availableActions: [] });
  let resolve!: () => void; f.waitState(new Promise<void>(done => { resolve = done; }));
  const oldPoll = f.session.poll(f.record.sessionId);
  const release = f.session.holdShutdown(f.record.sessionId); release(); resolve(); await oldPoll;
  expect(f.incoming.filter(message => message.type === "control_state")).toHaveLength(0);
  expect(f.session.connected(f.record.sessionId)).toBe(true);
});

test.each(["close", "disconnect", "offer"] as const)("a shutdown hold preserves %s safety", async source => {
  const f = await setup(); f.activate(); f.setLocal({ state: "closing", controlEpoch: "2", availableActions: [] });
  const release = f.session.holdShutdown(f.record.sessionId);
  if (source === "close") f.session.close(f.record.sessionId);
  else if (source === "disconnect") f.socket.terminate();
  else f.socket.send(JSON.stringify(operationFixture));
  await vi.waitFor(() => expect(f.count().suspended).toBe(1));
  expect(f.session.connected(f.record.sessionId)).toBe(false); expect(f.count().inputCalls).toBe(0);
  release(); release(); expect(f.count().suspended).toBe(1);
});

test("a shutdown hold has a bounded confirmation window", async () => {
  const f = await setup(); f.activate(); f.setLocal({ state: "closing", controlEpoch: "2", availableActions: [] });
  vi.useFakeTimers();
  try {
    f.session.holdShutdown(f.record.sessionId);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.count().suspended).toBe(1); expect(f.session.connected(f.record.sessionId)).toBe(false);
  } finally { vi.useRealTimers(); }
});


test.each(["readiness", "cancel", "written"] as const)("publishes the durable initial %s result without confusing rejection with unknown input", async failure => {
  const f = await setup();
  const root = fileURLToPath(new URL("../../../../../.tmp/herdr-input/", import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "publication-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = openHerdrInputStore(path.join(directory, "input.sqlite"), { onMigration: () => {} });
  cleanup.push(() => store.close());
  const target = { sessionId: f.record.sessionId, claimId: f.record.claimId, executionGeneration: "1", connectionEpoch: "1", segmentId: f.record.segments[0]!.segmentId, binding: f.registration.payload.binding };
  store.bind(target);
  let rejectReadiness!: (reason: Error) => void, entered!: () => void;
  const readinessEntered = new Promise<void>(resolve => { entered = resolve; });
  let failing = true, writes = 0;
  const arbiter = createHerdrInputArbiter({ store, sessionId: target.sessionId,
    verify: async () => {
      if (failing && failure !== "written") { entered(); await new Promise<void>((_resolve, reject) => { rejectReadiness = reject; }); }
    },
    execute: async (_batch, context) => {
      await context.beforeWrite(); context.markWritten(); writes++;
      if (failing && failure === "written") { entered(); await new Promise<void>((_resolve, reject) => { rejectReadiness = reject; }); }
    },
  });
  f.useArbiter(arbiter); f.activate();
  // Close the owner before disposing its real journal, including failed assertions.
  cleanup.push(() => f.session.close());
  const publish = async (initial: SessionV2Payloads["control_state"]["initialAssignment"], state: "automation" | "suspended") => {
    const count = f.incoming.length;
    await f.session.poll(target.sessionId);
    await vi.waitFor(() => expect(f.incoming).toHaveLength(count + 1));
    const message = f.incoming.at(-1)!;
    expect(message).toMatchObject({ type: "control_state", payload: { initialAssignment: initial, state, connectionEpoch: "1" } });
    if (message.type !== "control_state") throw new Error("Expected a control publication.");
    f.setRemote({ control: { ...message.payload, availableActions: [] } });
    f.socket.send(JSON.stringify(message));
  };
  await publish("pending", "automation");
  const controller = new AbortController();
  const request = { operationId: arbiter.record().initialOperationId, source: "initial" as const, text: "original assignment" };
  const first = arbiter.submit(request, controller.signal);
  await readinessEntered; await publish("dispatching", "automation");
  if (failure === "cancel") controller.abort(new Error("Cancelled before input"));
  else rejectReadiness(new Error("Readiness or transport failed"));
  const receipt = await first;
  if (failure === "cancel") rejectReadiness(new Error("Cancelled readiness settled"));
  expect(receipt.state).toBe(failure === "written" ? "unknown" : "rejected");
  expect(writes).toBe(failure === "written" ? 1 : 0);
  await publish(failure === "written" ? "unknown" : "pending", failure === "written" ? "suspended" : "automation");
  failing = false;
  if (failure === "written") {
    expect(await arbiter.submit(request)).toEqual(receipt);
    expect(writes).toBe(1);
  } else {
    const retry = await arbiter.submit(request);
    expect(retry.state).toBe("transport_completed");
    expect(retry.operationId).not.toBe(receipt.operationId);
    expect(arbiter.record().operations.find(op => op.operationId === receipt.operationId)?.result).toEqual(receipt);
    expect(writes).toBe(1);
    await publish("transport_completed", "automation");
  }
  expect(f.session.connected(target.sessionId)).toBe(true);
  expect(f.count().suspended).toBe(0);
});


test("publishes a snapshot only for the current active registered segment", async () => {
  const f = await setup();
  const snapshot = structuredClone(snapshotFixture) as Message<"snapshot">;
  await expect(f.session.publishSnapshot(f.record.sessionId, snapshot.payload)).rejects.toThrow();
  f.activate();
  await expect(f.session.publishSnapshot(f.record.sessionId, snapshot.payload)).resolves.toBeUndefined();
  await vi.waitFor(() => expect(f.incoming.at(-1)?.type).toBe("snapshot"));
  await expect(f.session.publishSnapshot(f.record.sessionId, { ...snapshot.payload, segmentId: "00000000-0000-4000-8000-000000000099" })).rejects.toThrow();
  f.record.segments[0]!.endedAt = "2026-11-04T00:00:01.000Z";
  await expect(f.session.publishSnapshot(f.record.sessionId, snapshot.payload)).rejects.toThrow();
});
