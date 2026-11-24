import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderOptions } from "../../../src/commands/controller/providers/types.js";

const native = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(), opened: vi.fn(), openGate: null as Promise<void> | null, captureGate: null as Promise<void> | null }));
vi.mock("node:net", async importOriginal => {
  const net = await importOriginal<typeof import("node:net")>();
  const { relative } = await import("node:path");
  const endpoint = (value: string) => process.platform === "win32" ? value : relative(process.cwd(), value);
  return { ...net,
    createServer: (...args: Parameters<typeof net.createServer>) => {
      const server = net.createServer(...args), listen = server.listen;
      server.listen = ((value: string, callback: () => void) => listen.call(server, endpoint(value), callback)) as typeof server.listen;
      return server;
    },
    createConnection: (value: string) => net.createConnection(endpoint(value)),
  };
});
vi.mock("../../../src/commands/controller/process-proof.js", async importOriginal => ({ ...await importOriginal<typeof import("../../../src/commands/controller/process-proof.js")>(), captureControllerProcessProof: async () => ({ pid: 1, parentPid: 0, processGroupId: 1, startedAt: "test", commandHash: "a".repeat(64) }), captureProcessProof: async () => { await native.captureGate; return { pid: 42, parentPid: 1, processGroupId: 1, startedAt: "test", commandHash: "a".repeat(64) }; } }));
vi.mock("../../../src/commands/controller/relay.js", () => ({ createControllerRelay: (_ticket: unknown, _journal: unknown, callbacks: { onConnection(connected: boolean): void }) => {
  queueMicrotask(() => callbacks.onConnection(true));
  return { flush: async () => {}, close: () => {}, connected: () => true, receipt: () => {} };
} }));
vi.mock("../../../src/commands/controller/providers/claude.js", () => ({ openClaudeProvider: async (options: ProviderOptions) => {
  native.opened(options);
  options.onState({ nativeSessionId: "00000000-0000-4000-8000-000000000099", activity: "idle", currentTurnId: null, capabilities: { send: true, steer: false, cancel: true, respond: true } });
  if (native.captureGate) options.onSpawn!({ pid: 42 } as never);
  if (native.openGate) await native.openGate;
  return { nativeSessionId: "00000000-0000-4000-8000-000000000099", send: native.send, close: native.close, cancel: async () => {} };
} }));
import { runController } from "../../../src/commands/controller/runtime.js";
import { requestController, type WorkerInputAction } from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, writeLaunchTicket, type ControllerLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { openControllerLifecycleStore, recordStoppedControllerGeneration, readRecoverableInitialInput } from "../../../src/commands/controller/lifecycle-store.js";
import { openControllerWorkerLifecycle } from "../../../src/commands/controller/worker-lifecycle.js";
import { openLifecycleStore, type LifecycleBinding } from "../../../src/commands/worker/lifecycle-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

const roots: string[] = [];
afterEach(async () => { native.openGate = null; native.captureGate = null; vi.unstubAllEnvs(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async (options: { openGate?: Promise<void>; captureGate?: Promise<void>; recovery?: "absent" | "accepted" | "dispatching"; lifecycleReservation?: boolean; interruption?: "journal" | "reservation"; settledReservation?: boolean } = {}) => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp"); await mkdir(base, { recursive: true });
  const home = await mkdtemp(path.join(base, "worker-ipc-")); roots.push(home);
  const state = path.join(home, ".daynight"); vi.stubEnv("DN_CONFIG_DIR", state); await mkdir(state, { recursive: true });
  let paused = false, claimValid = true, reads = 0, wrongUser = false, failRead = false;
  let gate: Promise<void> | null = null;
  const http = createHttpServer(async (req, res) => {
    reads++;
    const pending = gate;
    if (pending) await pending;
    expect(req.method).toBe("GET"); expect(req.url).toBe(`/api/v1/projects/${ticket.projectId}/tasks/${ticket.taskId}`);
    expect(req.headers.authorization).toBe("Bearer fixture-token");
    if (failRead) { res.writeHead(403, { "content-type": "application/json", "daynight-user-id": ticket.userId! }); res.end(JSON.stringify({ error: "denied" })); return; }
    const now = new Date().toISOString();
    const task = { id: ticket.taskId, projectId: ticket.projectId, type: "task", parentId: null, title: "Task", description: "", tags: [], status: "in_progress", allowAgents: true, requiredPlatform: null, assignedTo: ticket.userId, startedAt: now, completedAt: null, cancelledAt: null, dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false, createdAt: now, updatedAt: now, version: 1, properties: { blocked: paused, worker: { claimId: claimValid ? ticket.claimId : randomUUID(), state: "active", userId: ticket.userId, workerId: ticket.workerId, machine: { id: randomUUID(), name: "test" }, platform: "linux", agent: "claude", agentControlMode: "web", worktreeId: ticket.worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: now } } };
    res.writeHead(200, { "content-type": "application/json", "daynight-user-id": wrongUser ? randomUUID() : ticket.userId! }); res.end(JSON.stringify(task));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
  let ticket: ControllerLaunchTicket = { schemaVersion: 1, launchId: randomUUID(), executionId: randomUUID(), controllerId: randomUUID(), controllerInstanceId: randomUUID(), sessionId: randomUUID(), executionGeneration: "1", serverOrigin: `http://127.0.0.1:${address.port}`, projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), workerId: randomUUID(), worktreeId: randomUUID(), userId: randomUUID(), provider: "claude", cwd: process.cwd(), nativeHome: path.join(home, "native"), configuration: { agent: "claude", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 }, initialOperationId: randomUUID(), initialPrompt: "initial assignment", resumeNativeSessionId: null, credentialFile: path.join(home, "grant.json"), ipcEndpoint: process.platform === "win32" ? String.raw`\\.\pipe\daynight-worker-ipc-${randomUUID()}` : path.join(home, "c.sock"), ipcSecret: "a".repeat(64), createdAt: new Date().toISOString() };
  let lifecycle: ReturnType<typeof openLifecycleStore> | undefined;
  if (options.lifecycleReservation) {
    const workerDirectory = resolveWorkerPaths(home).workerDirectory; await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
    const identity = { serverOrigin: ticket.serverOrigin, userId: ticket.userId!, workerId: ticket.workerId! };
    lifecycle = openLifecycleStore({ file: path.join(workerDirectory, "lifecycle.sqlite"), identity, allowCreate: true });
    const binding: LifecycleBinding = { ...identity, instanceId: randomUUID(), intentVersion: "1", localEpoch: "1", scopeGeneration: "1" };
    lifecycle.bindInstance({ ...binding, desired: "enabled" }); lifecycle.markStopped({ localEpoch: "1", inventoryRevision: lifecycle.readState().inventoryRevision });
    const activation = { binding, operationId: randomUUID(), action: "bootstrap" as const };
    lifecycle.prepareActivation(activation);
    lifecycle.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action: "bootstrap", workerId: identity.workerId, operationId: activation.operationId, instanceId: binding.instanceId, intentVersion: "1", localEpoch: "1", scopeGeneration: "1" } });
    ticket = { ...ticket, schemaVersion: 2, lifecycleBinding: binding };
  }
  if (options.recovery) {
    const journalFile = path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite");
    await mkdir(path.dirname(journalFile), { recursive: true });
    await writeLaunchTicket(home, ticket);
    const prior = openControllerLifecycleStore(journalFile, ticket, { controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: 2_000_000_000, startedAt: "test", commandHash: "a".repeat(64) } });
    prior.patchSnapshot({ nativeSessionId: "00000000-0000-4000-8000-000000000099", lifecycle: "ready", activity: "idle" });
    if (options.recovery !== "absent") {
      const prepared = prior.prepareOperation({ operationId: ticket.initialOperationId, kind: "initial", payload: { text: ticket.initialPrompt } });
      if (options.lifecycleReservation) { const authority = openControllerWorkerLifecycle(home, ticket)!; authority.reserve(prepared, "00000000-0000-4000-8000-000000000099"); authority.close(); }
    }
    if (options.recovery === "dispatching") prior.markDispatching(ticket.initialOperationId);
    prior.close();
    await recordStoppedControllerGeneration(journalFile, ticket, {});
    const first = ticket;
    ticket = { ...ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "2", resumeNativeSessionId: "00000000-0000-4000-8000-000000000099" };
    if (options.settledReservation) {
      const store = lifecycle!;
      store.closeAdmission({ operationId: randomUUID(), local: false });
      store.settlePreparedControllerInput(store.getResource(ticket.initialOperationId)!);
      store.markStopped({ localEpoch: "1", inventoryRevision: store.readState().inventoryRevision });
      const binding = { ...ticket.lifecycleBinding!, scopeGeneration: "2" };
      const activation = { binding, operationId: randomUUID(), action: "reconnect" as const };
      store.prepareActivation(activation);
      store.commitActivation({ ...activation, receipt: { protocolVersion: 1, admission: "open", action: "reconnect", workerId: ticket.workerId!, operationId: activation.operationId, instanceId: binding.instanceId, intentVersion: "1", localEpoch: "1", scopeGeneration: "2" } });
      ticket = { ...ticket, lifecycleBinding: binding };
    }
    if (options.interruption) {
      await writeLaunchTicket(home, ticket);
      const second = openControllerLifecycleStore(journalFile, ticket, { controllerProcess: { pid: 2_000_000_000, parentPid: 1, processGroupId: 2_000_000_000, startedAt: "test", commandHash: "a".repeat(64) } });
      second.patchSnapshot({ lifecycle: "ready", activity: "idle", startup: { state: "ready", reasonCode: "ready" }, capabilities: { send: true, steer: false, cancel: false, respond: false } });
      const adopted = second.prepareRecoveredInitial(first);
      if (options.interruption === "reservation") {
        const authority = openControllerWorkerLifecycle(home, ticket)!;
        const resource = authority.inputReservation(ticket.initialOperationId)!;
        second.assertRecoveredInitialReservation(first, first);
        authority.reserve(adopted, ticket.resumeNativeSessionId, { resource, ticket: first });
        authority.close();
      }
      second.close();
      await recordStoppedControllerGeneration(journalFile, ticket, {});
      ticket = { ...ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "3" };
    }
  }
  await writeFile(path.join(state, "config.yml"), `serverUrl: ${ticket.serverOrigin}\nserverToken: fixture-token\n`);
  await writeLaunchTicket(home, ticket);
  native.send.mockResolvedValue({ disposition: "started", turnId: "turn" }); native.close.mockResolvedValue(undefined);
  native.openGate = options.openGate ?? null; native.captureGate = options.captureGate ?? null;
  const running = runController({ homeDirectory: home, provider: "claude", launchId: ticket.launchId }); void running.catch(() => {});
  const pendingStartup = options.openGate !== undefined || options.captureGate !== undefined;
  await vi.waitFor(async () => expect((await requestController(ticket, { kind: "observe" })).snapshot.lifecycle).toBe(pendingStartup ? "starting" : "ready"));
  if (pendingStartup) await vi.waitFor(() => expect(native.opened).toHaveBeenCalledOnce());
  const journal = path.join(controllerExecutionDirectory(home, ticket.executionId), "journal.sqlite");
  return { ticket, running, journal, home, lifecycle, config: path.join(state, "config.yml"), setPaused: (value: boolean) => { paused = value; }, setClaimValid: (value: boolean) => { claimValid = value; }, setGate: (value: Promise<void> | null) => { gate = value; }, setWrongUser: (value: boolean) => { wrongUser = value; }, setFailRead: (value: boolean) => { failRead = value; }, reads: () => reads,
    state: (activity: "idle" | "working") => (native.opened.mock.calls[0]![0] as ProviderOptions).onState({ nativeSessionId: "00000000-0000-4000-8000-000000000099", activity, currentTurnId: activity === "working" ? "turn" : null, capabilities: { send: true, steer: activity === "working", cancel: true, respond: true } }),
    operation: (id: string) => { const db = new Database(journal, { readonly: true }); try { const row = db.prepare("SELECT value FROM operations WHERE id=?").get(id) as { value: string } | undefined; return row && JSON.parse(row.value); } finally { db.close(); } },
    stop: async (failed = false) => { try { if (!failed) await requestController(ticket, { kind: "stop", deadline: Date.now() + 2000 }); await running; } finally { lifecycle?.close(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); } } };
};
const action = (operationId = randomUUID(), prompt = "continue"): WorkerInputAction => ({ kind: "submit_worker_input", operationId, prompt, deadline: Date.now() + 10_000 });

test.skipIf(process.platform === "win32").each(["absent", "accepted"] as const)("recovered %s initial input uses the original journal and dispatches once", async recovery => {
  const v = await setup({ recovery });
  try {
    expect(await requestController(v.ticket, { kind: "observe" })).toMatchObject({ workerInputProtocol: 1, recoveredInitialInputProtocol: 1 });
    const before = await readRecoverableInitialInput(v.journal, v.ticket, v.home);
    expect(before.snapshot).toMatchObject({ executionGeneration: "2", initialInputState: "not_submitted", nativeSessionId: v.ticket.resumeNativeSessionId });
    expect(before.operation?.state ?? null).toBe(recovery === "accepted" ? "accepted" : null);
    const input = { kind: "submit_initial", operationId: v.ticket.initialOperationId } as const;
    const results = await Promise.all([requestController(v.ticket, input), requestController(v.ticket, input)]);
    expect(results.map(result => result.operation?.state)).toEqual(["confirmed", "confirmed"]);
    expect(native.send).toHaveBeenCalledOnce();
    expect(native.send.mock.calls[0]![1]).toBe(v.ticket.initialOperationId);
    expect(v.operation(v.ticket.initialOperationId)).toMatchObject({ executionGeneration: "2", state: "confirmed", payload: { text: v.ticket.initialPrompt } });
    expect((await requestController(v.ticket, input)).operation?.state).toBe("confirmed");
    expect(native.send).toHaveBeenCalledOnce();
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32")("a previous durable dispatch is never sent again", async () => {
  const v = await setup({ recovery: "dispatching" });
  try {
    await expect(readRecoverableInitialInput(v.journal, v.ticket, v.home)).rejects.toThrow();
    const result = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(result.operation?.state).toBe("dispatching");
    expect(native.send).not.toHaveBeenCalled();
    expect(v.operation(v.ticket.initialOperationId)).toMatchObject({ executionGeneration: "1", state: "dispatching" });
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32")("the original prepared lifecycle reservation is adopted by the current generation before native dispatch", async () => {
  const v = await setup({ recovery: "accepted", lifecycleReservation: true });
  try {
    expect(v.lifecycle!.getResource(v.ticket.initialOperationId)).toMatchObject({ stage: "reserved", identity: { executionGeneration: "1", operationKind: "initial" } });
    const response = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(response.operation).toMatchObject({ executionGeneration: "2", state: "confirmed" });
    expect(v.lifecycle!.getResource(v.ticket.initialOperationId)).toMatchObject({ stage: "confirmed", identity: { executionGeneration: "2", controllerInstanceId: v.ticket.controllerInstanceId, launchId: v.ticket.launchId } });
    expect(native.send).toHaveBeenCalledOnce();
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32")("closed lifecycle admission prevents adoption of the original prepared reservation", async () => {
  const v = await setup({ recovery: "accepted", lifecycleReservation: true });
  try {
    v.lifecycle!.closeAdmission({ operationId: randomUUID(), local: true });
    const response = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(response.operation?.state).toBe("accepted");
    expect(v.lifecycle!.getResource(v.ticket.initialOperationId)).toMatchObject({ stage: "reserved", identity: { executionGeneration: "1" } });
    expect(native.send).not.toHaveBeenCalled();
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32").each(["journal", "reservation"] as const)("third generation recovers after interruption following %s adoption", async interruption => {
  const v = await setup({ recovery: "accepted", lifecycleReservation: true, interruption });
  try {
    expect(v.operation(v.ticket.initialOperationId)).toMatchObject({ state: "accepted", executionGeneration: "2" });
    expect(v.lifecycle!.getResource(v.ticket.initialOperationId)).toMatchObject({ stage: "reserved", identity: { executionGeneration: interruption === "journal" ? "1" : "2" } });
    const response = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(response.operation).toMatchObject({ state: "confirmed", executionGeneration: "3" });
    expect(v.lifecycle!.getResource(v.ticket.initialOperationId)).toMatchObject({ stage: "confirmed", identity: { executionGeneration: "3", launchId: v.ticket.launchId } });
    expect(native.send).toHaveBeenCalledOnce();
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32")("recovery after a stopped reservation retains its terminal history and uses a new responsibility", async () => {
  const v = await setup({ recovery: "accepted", lifecycleReservation: true, settledReservation: true });
  try {
    const old = v.lifecycle!.getResource(v.ticket.initialOperationId)!;
    expect(old.stage).toBe("not_dispatched");
    const response = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(response.operation).toMatchObject({ state: "confirmed", executionGeneration: "2" });
    expect(v.lifecycle!.getResource(old.resourceId)).toEqual(old);
    expect(v.lifecycle!.listResources().filter(resource => resource.operationId === v.ticket.initialOperationId)).toEqual(expect.arrayContaining([
      old, expect.objectContaining({ resourceId: expect.not.stringMatching(old.resourceId), stage: "confirmed", identity: expect.objectContaining({ executionGeneration: "2" }) }),
    ]));
    expect(native.send).toHaveBeenCalledOnce();
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32").each(["journal", "reservation"] as const)("third generation finds the original operation after settled history and %s interruption", async interruption => {
  const v = await setup({ recovery: "accepted", lifecycleReservation: true, settledReservation: true, interruption });
  try {
    expect(v.lifecycle!.getResource(v.ticket.initialOperationId)?.stage).toBe("not_dispatched");
    expect((await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId })).operation).toMatchObject({ state: "confirmed", executionGeneration: "3" });
    const records = v.lifecycle!.listResources().filter(resource => resource.operationId === v.ticket.initialOperationId);
    expect(records).toHaveLength(2);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: v.ticket.initialOperationId, stage: "not_dispatched" }),
      expect.objectContaining({ stage: "confirmed", identity: expect.objectContaining({ executionGeneration: "3" }) }),
    ]));
    expect(native.send).toHaveBeenCalledOnce();
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32").each([false, true])("a later Controller handles the original input receipt with duplicate=%s", async duplicate => {
  const v = await setup({ recovery: "accepted", lifecycleReservation: true, settledReservation: true });
  try {
    native.send.mockRejectedValueOnce(new Error("Native response lost"));
    const sent = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(sent.operation?.state).toBe("unknown");
    const original = v.lifecycle!.getResource(v.ticket.initialOperationId)!;
    const actual = v.lifecycle!.listResources().find(resource => resource.operationId === v.ticket.initialOperationId && resource.resourceId !== original.resourceId)!;
    expect(actual).toMatchObject({ stage: "unknown", identity: { executionGeneration: "2" } });
    if (duplicate) v.lifecycle!.reserveExecution({ binding: v.ticket.lifecycleBinding!, resourceId: randomUUID(), operationId: v.ticket.initialOperationId, ownerKind: "controller", identity: actual.identity });
    const third = { ...v.ticket, launchId: randomUUID(), controllerInstanceId: randomUUID(), executionGeneration: "3" };
    const later = openControllerWorkerLifecycle(v.home, third)!;
    try {
      const receipt = { ...sent.operation!, state: "confirmed" as const, error: null };
      if (duplicate) expect(() => later.settle(receipt)).toThrow(/multiple matching/);
      else { later.settle(receipt); expect(v.lifecycle!.getResource(actual.resourceId)?.stage).toBe("confirmed"); }
      expect(v.lifecycle!.getResource(original.resourceId)).toEqual(original);
    } finally { later.close(); }
  } finally { await v.stop(); }
});

test.skipIf(process.platform === "win32").each(["missing stop", "native identity", "previous generation", "operation id", "payload", "hash", "unknown", "terminal"] as const)("recovered initial input refuses inconsistent %s evidence", async damaged => {
  const v = await setup({ recovery: "accepted" });
  try {
    const db = new Database(v.journal);
    try {
      if (damaged === "missing stop") db.exec("DELETE FROM stopped_generations");
      else if (damaged === "native identity") db.prepare("UPDATE stopped_generations SET snapshot=json_set(snapshot,'$.nativeSessionId',?)").run(randomUUID());
      else if (damaged === "previous generation") db.exec("UPDATE stopped_generations SET snapshot=json_set(snapshot,'$.executionGeneration','3')");
      else {
        const row = db.prepare("SELECT value FROM operations WHERE id=?").get(v.ticket.initialOperationId) as { value: string };
        const operation = JSON.parse(row.value);
        if (damaged === "operation id") operation.operationId = randomUUID();
        if (damaged === "payload") operation.payload.text = "different";
        if (damaged === "hash") operation.payloadHash = "b".repeat(64);
        if (damaged === "unknown" || damaged === "terminal") operation.state = damaged === "unknown" ? "unknown" : "confirmed";
        db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify(operation), v.ticket.initialOperationId);
      }
    } finally { db.close(); }
    await expect(readRecoverableInitialInput(v.journal, v.ticket, v.home)).rejects.toThrow();
    await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId }).catch(() => undefined);
    expect(native.send).not.toHaveBeenCalled();
  } finally { await v.stop(); }
});

test("fatal startup after idle prevents Worker input before the provider handle arrives", async () => {
  const gate = Promise.withResolvers<void>();
  const v = await setup({ openGate: gate.promise });
  try {
    const provider = native.opened.mock.calls[0]![0] as ProviderOptions;
    provider.onFatalError!(new Error("native startup failed"));
    expect((await requestController(v.ticket, { kind: "observe" })).snapshot).toMatchObject({ lifecycle: "paused", activity: "idle", capabilities: { send: true } });
    const input = action(), before = v.reads();
    expect((await requestController(v.ticket, input)).inputResult).toEqual({ kind: "waiting", reason: "unavailable" });
    v.state("idle");
    expect((await requestController(v.ticket, { kind: "observe" })).snapshot).toMatchObject({ lifecycle: "starting", activity: "idle", capabilities: { send: true } });
    expect((await requestController(v.ticket, input)).inputResult).toEqual({ kind: "waiting", reason: "unavailable" });
    expect(v.reads()).toBe(before); expect(v.operation(input.operationId)).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
  } finally { gate.resolve(); await expect(v.stop(true)).rejects.toThrow("native startup failed"); }
});

test("initial input waits for native process proof after the provider handle arrives", async () => {
  const gate = Promise.withResolvers<void>();
  const v = await setup({ captureGate: gate.promise });
  try {
    const before = v.reads();
    const result = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(result.snapshot).toMatchObject({ lifecycle: "starting", activity: "idle", initialInputState: "not_submitted" });
    expect(result.operation).toBeUndefined(); expect(v.reads()).toBe(before);
    expect(v.operation(v.ticket.initialOperationId)).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(async () => expect((await requestController(v.ticket, { kind: "observe" })).snapshot.lifecycle).toBe("ready"));
    expect((await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId })).operation).toMatchObject({ state: "confirmed" });
    expect(native.send).toHaveBeenCalledOnce();
  } finally { gate.resolve(); await v.stop(); }
});

test("initial and later input reread the task and recheck idle after the GET", async () => {
  const v = await setup();
  try {
    v.setPaused(true);
    const paused = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(paused.operation).toBeUndefined(); expect(v.operation(v.ticket.initialOperationId)).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
    v.setPaused(false); v.setClaimValid(false);
    const invalid = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(invalid.operation).toBeUndefined(); expect(native.send).not.toHaveBeenCalled();
    v.setClaimValid(true);
    const initial = await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    expect(initial.operation).toMatchObject({ kind: "initial", operationId: v.ticket.initialOperationId, state: "confirmed" });
    expect(native.send).toHaveBeenCalledTimes(1);
    const hold = Promise.withResolvers<void>(); v.setGate(hold.promise);
    const next = action(), before = v.reads();
    const waiting = requestController(v.ticket, next);
    await vi.waitFor(() => expect(v.reads()).toBe(before + 1));
    v.state("working"); hold.resolve(); v.setGate(null);
    expect((await waiting).inputResult).toEqual({ kind: "waiting", reason: "working" });
    expect(v.operation(next.operationId)).toBeUndefined(); expect(native.send).toHaveBeenCalledTimes(1);
    v.state("idle");
    expect((await requestController(v.ticket, next)).inputResult).toMatchObject({ kind: "operation", operation: { kind: "worker_input", state: "confirmed" } });
    expect(native.send).toHaveBeenCalledTimes(2);
  } finally { await v.stop(); }
});

test("configuration, principal and GET failures never dispatch or register the input", async () => {
  const v = await setup();
  try {
    await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    const next = action(), initialReads = v.reads();
    await writeFile(v.config, "serverUrl: http://127.0.0.1:1\nserverToken: fixture-token\n");
    await expect(requestController(v.ticket, next)).rejects.toThrow(/configuration/);
    expect(v.reads()).toBe(initialReads);
    await writeFile(v.config, `serverUrl: ${v.ticket.serverOrigin}\n`);
    await expect(requestController(v.ticket, next)).rejects.toThrow(/configuration/);
    expect(v.reads()).toBe(initialReads);
    await writeFile(v.config, `serverUrl: ${v.ticket.serverOrigin}\nserverToken: fixture-token\n`);
    v.setWrongUser(true);
    await expect(requestController(v.ticket, next)).rejects.toThrow();
    expect(v.reads()).toBe(initialReads + 1);
    v.setWrongUser(false); v.setFailRead(true);
    await expect(requestController(v.ticket, next)).rejects.toThrow();
    expect(v.reads()).toBe(initialReads + 2);
    expect(v.operation(next.operationId)).toBeUndefined(); expect(native.send).toHaveBeenCalledTimes(1);
    v.setFailRead(false);
    expect((await requestController(v.ticket, next)).inputResult).toMatchObject({ kind: "operation", operation: { operationId: next.operationId, state: "confirmed" } });
    expect(native.send).toHaveBeenCalledTimes(2);
  } finally { await v.stop(); }
});

test("queued Worker requests recheck the task, preserve IDs and expire without dispatch", async () => {
  const v = await setup();
  const release = Promise.withResolvers<{ disposition: "started"; turnId: string }>();
  try {
    await requestController(v.ticket, { kind: "submit_initial", operationId: v.ticket.initialOperationId });
    native.send.mockReturnValueOnce(release.promise);
    const first = action(), blocked = requestController(v.ticket, first);
    await vi.waitFor(() => expect(native.send).toHaveBeenCalledTimes(2));
    const second = action(), queued = requestController(v.ticket, second);
    await expect(requestController(v.ticket, { ...second, prompt: "changed queued input" })).rejects.toThrow(/different content/);
    const duplicate = requestController(v.ticket, first);
    await expect(requestController(v.ticket, { ...first, prompt: "changed" })).rejects.toThrow(/different content/);
    const expired = { ...action(), deadline: Date.now() + 100 };
    const expiry = requestController(v.ticket, expired);
    await expect(requestController(v.ticket, { ...expired, prompt: "changed expiring input" })).rejects.toThrow(/different content/);
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(expired.deadline));
    v.setPaused(true); release.resolve({ disposition: "started", turnId: "turn" });
    expect((await blocked).inputResult).toMatchObject({ kind: "operation", operation: { operationId: first.operationId, state: "confirmed" } });
    expect((await duplicate).inputResult).toMatchObject({ kind: "operation", operation: { operationId: first.operationId, state: "confirmed" } });
    expect((await queued).inputResult).toEqual({ kind: "waiting", reason: "task_paused" });
    expect((await expiry).inputResult).toEqual({ kind: "waiting", reason: "expired" });
    expect(v.operation(second.operationId)).toBeUndefined(); expect(v.operation(expired.operationId)).toBeUndefined(); expect(native.send).toHaveBeenCalledTimes(2);
    v.setPaused(false); v.setClaimValid(false);
    expect((await requestController(v.ticket, second)).inputResult).toEqual({ kind: "waiting", reason: "claim_invalid" });
    v.setClaimValid(true);
    expect((await requestController(v.ticket, second)).inputResult).toMatchObject({ kind: "operation", operation: { operationId: second.operationId, state: "confirmed" } });
    expect(native.send).toHaveBeenCalledTimes(3);
  } finally { release.resolve({ disposition: "started", turnId: "turn" }); await v.stop(); }
});
