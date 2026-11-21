import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import { parseLifecycleObservationEnvelope, type LifecycleActivationRequest, type LifecycleActivationReceipt, type LifecycleInstanceRequest, type LifecycleInstanceReceipt, type LifecycleIntentRequest, type LifecycleIntentReceipt, type LifecycleObservationEnvelope, type LifecycleOperationResult, type LifecycleResolveRequest, type LifecycleResource } from "../../../src/api/worker-lifecycle.js";
import type { WorkerLifecycleClient } from "../../../src/api/worker-lifecycle-client.js";
import { createLifecycleManager, type LifecycleExecutionControl } from "../../../src/commands/worker/lifecycle-manager.js";
import { openLifecycleStore } from "../../../src/commands/worker/lifecycle-store.js";
import type { OwnerStopResult } from "../../../src/commands/worker/execution-scope.js";

const root = fileURLToPath(new URL("../../../../../.tmp/lifecycle-manager-tests/", import.meta.url));
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const identity = { serverOrigin: "https://daynight.example", userId: id(1), workerId: id(2) };
const time = "2026-11-21T00:00:00.000Z";
const unknown = () => new ApiError({ operation: "test.lifecycle" }, "request", { cause: new Error("Response lost"), outcomeUnconfirmed: true });
const missing = () => new ApiError({ operation: "test.lifecycle" }, "response", { cause: new Error("Missing original result"), status: 404, confirmedRefusal: true });
const deferred = <T>() => Promise.withResolvers<T>();
const waitSignal = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (signal === undefined) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
};
const cleanups: (() => Promise<void>)[] = [];

const fixture = () => {
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "manager-")); chmodSync(directory, 0o700);
  const file = path.join(directory, "lifecycle.sqlite"), store = openLifecycleStore({ file, identity, allowCreate: true });
  const cancellation = new AbortController(), errors: unknown[] = [], receipts = new Map<string, LifecycleOperationResult>();
  let cloud: LifecycleResource = { protocolVersion: 1, workerId: identity.workerId, intentVersion: "1", desired: "enabled", admission: "closed", operationId: null, instance: null, capability: "supported", observation: null, observedAt: time };
  let readGate: Promise<LifecycleResource> | undefined;
  let activationHook: ((request: LifecycleActivationRequest, receipt: LifecycleActivationReceipt) => Promise<void> | void) | undefined;
  let reportHook: ((request: LifecycleObservationEnvelope) => Promise<void> | void) | undefined;
  const readStarted = deferred<void>();
  const api: WorkerLifecycleClient = {
    read: vi.fn(async (signal?: AbortSignal) => { if (readGate !== undefined) { readStarted.resolve(); return waitSignal(readGate, signal); } return structuredClone(cloud); }),
    register: vi.fn(async (request: LifecycleInstanceRequest) => {
      const receipt: LifecycleInstanceReceipt = { protocolVersion: 1, workerId: identity.workerId, operationId: request.operationId, instanceId: request.instanceId, instanceEpoch: String(BigInt(request.previousInstanceEpoch ?? "0") + 1n), intentVersion: cloud.intentVersion, desired: cloud.desired, admission: "closed", reconnectAllowed: cloud.admission === "open", observedAt: time };
      cloud = { ...cloud, admission: "closed", instance: { instanceId: receipt.instanceId, instanceEpoch: receipt.instanceEpoch }, observation: null };
      receipts.set(receipt.operationId, { kind: "instance", receipt }); return receipt;
    }),
    intent: vi.fn(async (request: LifecycleIntentRequest) => {
      if (request.action === "resume") {
        expect(cloud.admission).toBe("closed");
        expect(cloud.observation?.observation).toMatchObject({ phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true });
        expect([null, "resume_interrupted", "upload_failed"]).toContain(cloud.observation?.observation.errorCode);
      }
      const receipt: LifecycleIntentReceipt = { protocolVersion: 1, workerId: identity.workerId, operationId: request.operationId, action: request.action, intentVersion: String(BigInt(request.expectedVersion) + 1n), desired: request.action === "disable" ? "disabled" : "enabled", admission: "closed", state: "accepted", errorCode: null, observedAt: time };
      cloud = { ...cloud, intentVersion: receipt.intentVersion, desired: receipt.desired, admission: "closed", operationId: receipt.operationId, observation: null };
      receipts.set(receipt.operationId, { kind: "intent", receipt, activation: null, activationOutcome: "not_started" }); return receipt;
    }),
    activate: vi.fn(async (request: LifecycleActivationRequest) => {
      expect(cloud.admission).toBe("closed");
      expect(cloud.observation?.observation).toMatchObject({ phase: "resuming", stop: "confirmed", save: "durable", inventoryComplete: true });
      expect([null, "upload_failed"]).toContain(cloud.observation?.observation.errorCode);
      const receipt: LifecycleActivationReceipt = { protocolVersion: 1, workerId: identity.workerId, operationId: request.operationId, action: "action" in request ? request.action : "resume", instanceEpoch: request.instanceEpoch, intentVersion: request.intentVersion, localEpoch: request.localEpoch, scopeGeneration: request.scopeGeneration, admission: "open", observedAt: time };
      cloud = { ...cloud, admission: "open" };
      const original = receipts.get(request.operationId);
      receipts.set(request.operationId, original?.kind === "intent" ? { ...original, activation: receipt, activationOutcome: "committed" } : { kind: "activation", receipt });
      await activationHook?.(request, receipt); return receipt;
    }),
    report: vi.fn(async (envelope: LifecycleObservationEnvelope) => {
      parseLifecycleObservationEnvelope(envelope);
      // This fixture asserts the server-owned association; it does not simulate native stopping.
      expect(envelope.operationId).toBe(cloud.operationId);
      if (envelope.observation.phase === "disabled") expect(cloud.admission).toBe("closed");
      cloud = { ...cloud, observation: { ...envelope, observation: { ...envelope.observation, receivedAt: time, freshUntil: "2026-11-21T00:00:30.000Z" } } };
      await reportHook?.(envelope);
      return { protocolVersion: 1, accepted: true, instanceEpoch: envelope.instanceEpoch, intentVersion: envelope.intentVersion, reportSequence: envelope.reportSequence, receivedAt: time } as const;
    }),
    operation: vi.fn(async (operationId: string) => { const result = receipts.get(operationId); if (result === undefined) throw missing(); return structuredClone(result); }),
    resolve: vi.fn(async (request: LifecycleResolveRequest) => { const result = receipts.get(request.request.operationId); if (result === undefined) throw new Error("Fixture requires an explicit original resolution."); return structuredClone(result); }),
  };
  const resources = vi.fn(async (_deadline: number) => {}), registration = vi.fn(async () => {});
  const manager = createLifecycleManager({ store, api, platform: "macos", signal: cancellation.signal, reconcileResources: resources, ensureWorkerRegistered: registration, reportError: error => { errors.push(error); } });
  let closed = false;
  const dispose = async () => {
    if (closed) return; closed = true; cancellation.abort(new Error("Fixture stopped"));
    try { await manager.close(); } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  };
  cleanups.push(dispose);
  return { directory, file, store, api, manager, cancellation, errors, receipts, resources, registration, dispose, readStarted,
    cloud: () => structuredClone(cloud), setCloud: (value: Partial<LifecycleResource>) => { cloud = { ...cloud, ...value }; },
    blockReads: (work: Promise<LifecycleResource>) => { readGate = work; },
    onActivation: (hook: typeof activationHook) => { activationHook = hook; },
    onReport: (hook: typeof reportHook) => { reportHook = hook; },
  };
};
const stopped: OwnerStopResult[] = [{ resourceId: "tasks", ownerKind: "task", generation: "1", stop: "confirmed", save: "durable", identity: { claims: [] } }];
const control = (): LifecycleExecutionControl & { stopped: ReturnType<typeof deferred<void>> } => {
  const observed = deferred<void>();
  return { stop: vi.fn(async () => { observed.resolve(); return stopped; }), reconcile: vi.fn(async () => stopped), rebuild: vi.fn(), stopped: observed };
};
const start = async (f: ReturnType<typeof fixture>) => { f.manager.start(); return f.manager.waitForAdmission(); };
const disable = async (f: ReturnType<typeof fixture>, operationId = id(20)) => {
  f.store.closeAdmission({ operationId, local: true });
  const intent = await f.api.intent({ protocolVersion: 1, action: "disable", operationId: id(21), expectedVersion: f.cloud().intentVersion, source: "local", localEpoch: f.store.readState().localEpoch, originOperationId: operationId });
  f.store.observeAuthority(intent);
  const snapshot = f.store.snapshot(); f.store.markStopped({ localEpoch: snapshot.state.localEpoch, inventoryRevision: snapshot.inventoryRevision, owners: [] });
};

afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

describe("Worker lifecycle management with real local authority", () => {
  it("bootstraps behind closed admission, then explicitly opens a new generation after disable", async () => {
    const f = fixture();
    const first = await start(f), owner = control(); f.manager.attach(owner);
    expect(first.scopeGeneration).toBe("1");
    expect(vi.mocked(f.api.report).mock.calls[0]![0]).toMatchObject({ operationId: null, observation: { phase: "resuming", stop: "confirmed", inventoryComplete: true } });
    await disable(f); await f.manager.resume(id(22));
    expect(f.manager.binding()).toMatchObject({ scopeGeneration: "2", localEpoch: "2", intentVersion: "3" });
    expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false });
    expect(owner.rebuild).toHaveBeenCalledOnce();
    expect(f.store.readOperation(id(22))).toMatchObject({ phase: "primary", status: "confirmed" });
    expect(f.store.readOperation(id(22), "activation")).toMatchObject({ phase: "activation", status: "confirmed" });
  });

  it("observes local closure independently while the cloud read is pending", async () => {
    const f = fixture(); await start(f); const owner = control(); f.manager.attach(owner);
    const gate = deferred<LifecycleResource>(); f.blockReads(gate.promise);
    await f.readStarted.promise;
    f.store.closeAdmission({ operationId: id(20), local: true });
    await owner.stopped.promise;
    expect(owner.stop).toHaveBeenCalled();
    expect(f.store.readState().admission).toBe("closed");
    gate.resolve(f.cloud());
  }, 5000);

  it("refreshes disabled observations without repeatedly stopping the same closed owners", async () => {
    const f = fixture(); await start(f); const owner = control(); f.manager.attach(owner);
    f.store.closeAdmission({ operationId: id(20), local: true });
    await expect.poll(() => ({ phase: f.store.readState().phase, desired: f.cloud().desired })).toEqual({ phase: "disabled", desired: "disabled" });
    await owner.stopped.promise;
    const reconciliations = vi.mocked(owner.reconcile).mock.calls.length, stops = vi.mocked(owner.stop).mock.calls.length, reports = vi.mocked(f.api.report).mock.calls.length;
    await expect.poll(() => vi.mocked(f.api.report).mock.calls.length, { timeout: 3500 }).toBeGreaterThanOrEqual(reports + 2);
    expect(vi.mocked(owner.reconcile).mock.calls).toHaveLength(reconciliations);
    expect(vi.mocked(owner.stop).mock.calls).toHaveLength(stops);
  }, 6000);

  it("reconciles an unknown report from the saved same-sequence observation before producing a new report", async () => {
    const f = fixture(), lost = deferred<void>(); let once = true;
    f.onReport(() => { if (once) { once = false; lost.resolve(); throw unknown(); } });
    f.manager.start(); await lost.promise;
    await expect.poll(() => f.store.listOutbox().filter(row => row.uploadState === "unknown").length).toBe(1);
    const original = f.store.listOutbox().find(row => row.uploadState === "unknown")!;
    await f.manager.waitForAdmission();
    expect(vi.mocked(f.api.report).mock.calls.filter(([request]: Parameters<WorkerLifecycleClient["report"]>) => request.reportSequence === original.reportSequence)).toHaveLength(1);
    expect(f.store.readOutboxHistory(original.id)).toMatchObject({ uploadState: "confirmed", receipt: { receivedAt: time } });
    expect(f.store.readState().sync).toBe("complete");
  }, 5000);

  it("reconciles the original unknown instance before registering the next instance", async () => {
    const f = fixture(), operationId = id(30), instanceId = id(31);
    const request = { protocolVersion: 1, operationId, instanceId, previousInstanceEpoch: null, capabilities: { disable: true, resume: true, inventory: 1, dispatchFence: 1 }, platform: "macos" };
    f.store.prepareOperation({ operationId, kind: "instance", request }); f.store.recordOperation({ operationId, status: "submitted" }); f.store.recordOperation({ operationId, status: "unknown" });
    const receipt: LifecycleInstanceReceipt = { protocolVersion: 1, operationId, workerId: identity.workerId, instanceId, instanceEpoch: "1", intentVersion: "1", desired: "enabled", admission: "closed", reconnectAllowed: false, observedAt: time };
    f.receipts.set(operationId, { kind: "instance", receipt }); f.setCloud({ instance: { instanceId, instanceEpoch: "1" } });
    const accepted = await start(f);
    expect(accepted.instanceEpoch).toBe("2");
    expect(f.api.operation).toHaveBeenCalledWith(operationId, f.cancellation.signal);
    expect(f.api.register).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.register).mock.calls[0]![0]).toMatchObject({ previousInstanceEpoch: "1" });
    expect(vi.mocked(f.api.register).mock.calls[0]![0].operationId).not.toBe(operationId);
  });

  it("keeps a lost activation closed until its original ID resolves and then commits only the local opening", async () => {
    const f = fixture(); await start(f); await disable(f);
    f.onActivation(request => { if (!("action" in request)) throw unknown(); });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "unknown" });
    expect(f.store.readState().admission).toBe("closed");
    await f.manager.reconcile();
    expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "confirmed" });
    expect(f.store.readState().admission).toBe("open");
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]: Parameters<WorkerLifecycleClient["activate"]>) => request.operationId === id(22))).toHaveLength(1);
  });

  it("preserves a later local veto when the remote resume activation returns", async () => {
    const f = fixture(); await start(f); await disable(f);
    f.onActivation(request => { if (!("action" in request)) f.store.closeAdmission({ operationId: id(24), local: true }); });
    await expect(f.manager.resume(id(22))).rejects.toThrow("binding is stale");
    expect(f.store.readState()).toMatchObject({ localEpoch: "3", localVeto: true, admission: "closed" });
  });

  it("keeps an interrupted resume closed across a new management instance until a new explicit resume", async () => {
    const f = fixture(); await start(f); await disable(f);
    f.onActivation(request => { if (!("action" in request)) throw unknown(); });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    f.cancellation.abort(new Error("Management process ended before local commit")); await f.manager.close();
    f.onActivation(undefined);
    const replacementCancellation = new AbortController();
    const replacement = createLifecycleManager({ store: f.store, api: f.api, platform: "macos", signal: replacementCancellation.signal, reconcileResources: f.resources, reportError: error => f.errors.push(error) });
    try {
      replacement.start();
      await expect.poll(() => f.store.readState().phase).toBe("disabled");
      expect(f.store.readState()).toMatchObject({ instanceEpoch: "2", localVeto: true, admission: "closed", scopeGeneration: "2" });
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]: Parameters<WorkerLifecycleClient["activate"]>) => request.operationId === id(22))).toHaveLength(1);
      expect(f.cloud()).toMatchObject({ desired: "enabled", admission: "closed", intentVersion: "3" });
      await replacement.resume(id(25));
      expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false, instanceEpoch: "2", scopeGeneration: "3" });
    } finally { replacementCancellation.abort(new Error("Replacement manager test ended")); await replacement.close(); }
  });

  it("does not open a scope when an owner has not proved stopping", async () => {
    const f = fixture(), owner = control();
    owner.reconcile = vi.fn<typeof owner.reconcile>(async () => [{ ...stopped[0]!, stop: "unknown", save: "failed" }]);
    f.manager.attach(owner); f.manager.start();
    await expect.poll(() => f.errors.length).toBeGreaterThan(0);
    expect(f.store.readState().admission).toBe("closed");
    expect(f.api.activate).not.toHaveBeenCalled(); expect(owner.rebuild).not.toHaveBeenCalled();
  });

  it("preserves confirmed local stop and save when the next authority read fails offline", async () => {
    const f = fixture(); await start(f); await disable(f);
    const before = f.store.readState();
    vi.mocked(f.api.read).mockRejectedValue(unknown());
    await expect.poll(() => f.errors.length).toBeGreaterThan(0);
    expect(f.store.readState()).toMatchObject({ admission: "closed", phase: "disabled", stop: "confirmed", save: "durable",
      inventoryComplete: true, sync: "failed", errorCode: "authority_unavailable", stopProof: before.stopProof });
  });

  it("clears only the recovered authority error before a disabled Worker explicitly resumes", async () => {
    const f = fixture(); await start(f); await disable(f);
    const read = vi.mocked(f.api.read).getMockImplementation()!;
    vi.mocked(f.api.read).mockRejectedValue(unknown());
    await expect.poll(() => f.store.readState().errorCode).toBe("authority_unavailable");
    expect(f.store.readState().localVeto).toBe(true);
    vi.mocked(f.api.read).mockImplementation(read);
    await expect.poll(() => f.cloud().observation?.observation.errorCode, { timeout: 3500 }).toBe(null);
    expect(f.store.readState()).toMatchObject({ phase: "disabled", localVeto: true, errorCode: null, sync: "complete" });
    await f.manager.resume(id(40));
    expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false });
    expect(f.api.register).toHaveBeenCalledOnce();
  }, 6000);

  it("re-registers a stopped scope before reporting disabled to previously open cloud authority", async () => {
    const f = fixture(); const first = await start(f), owner = control(); f.manager.attach(owner);
    const read = vi.mocked(f.api.read).getMockImplementation()!;
    vi.mocked(f.api.read).mockRejectedValue(unknown());
    await expect.poll(() => f.store.readState().errorCode).toBe("authority_unavailable");
    await owner.stopped.promise;
    expect(f.cloud().admission).toBe("open");
    expect(f.store.readState()).toMatchObject({ admission: "closed", localVeto: false });
    vi.mocked(f.api.read).mockImplementation(read);
    await expect.poll(() => f.store.readState().admission, { timeout: 5000 }).toBe("open");
    expect(f.manager.binding()).toMatchObject({ instanceEpoch: "2", scopeGeneration: "2", localEpoch: first.localEpoch });
    expect(f.api.register).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.activate).mock.calls[1]![0]).toMatchObject({ action: "reconnect", instanceEpoch: "2" });
    expect(f.api.intent).not.toHaveBeenCalled();
    expect(owner.rebuild).toHaveBeenCalledOnce();
    expect(f.store.readState().errorCode).toBe(null);
  }, 8000);

  it("initializes explicit control through normal reconnect without an attached execution scope", async () => {
    const f = fixture(); await start(f);
    f.store.closeForRestart(); f.cancellation.abort(); await f.manager.close();
    const cancellation = new AbortController();
    const manager = createLifecycleManager({ store: f.store, api: f.api, platform: "macos", signal: cancellation.signal, reconcileResources: f.resources, reportError: error => f.errors.push(error) });
    try {
      const binding = await manager.initializeForControl();
      expect(binding).toMatchObject({ instanceEpoch: "2", scopeGeneration: "2" });
      expect(() => f.store.assertAdmission(binding)).not.toThrow();
      expect(vi.mocked(f.api.activate).mock.calls[1]![0]).toMatchObject({ action: "reconnect" });
    } finally { cancellation.abort(); await manager.close(); }
  });

  it("retains a missing-Worker refusal and resumes only after registration succeeds again", async () => {
    const f = fixture();
    vi.mocked(f.api.register).mockRejectedValueOnce(missing());
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    const original = f.store.listOperations().find(operation => operation.kind === "instance")!;
    expect(original).toMatchObject({ status: "rejected", receipt: { status: 404 } });
    f.registration.mockRejectedValueOnce(missing());
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    expect(f.api.register).toHaveBeenCalledOnce();
    expect(f.store.readOperation(original.operationId)).toEqual(original);

    f.store.closeAdmission({ operationId: id(60), local: true });
    await f.manager.resume(id(61));
    expect(f.registration).toHaveBeenCalledTimes(3);
    expect(f.registration).toHaveBeenLastCalledWith(true);
    expect(f.api.register).toHaveBeenCalledTimes(2);
    const replacement = vi.mocked(f.api.register).mock.calls[1]![0];
    expect(replacement.operationId).not.toBe(original.operationId);
    expect(replacement.previousInstanceEpoch).toBeNull();
    expect(f.store.readOperation(original.operationId)).toEqual(original);
    expect(f.store.readOperation(replacement.operationId)?.status).toBe("confirmed");
    expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false });
    expect(f.store.readOperation(id(61), "activation")?.status).toBe("confirmed");
  });

  it("preserves a registration refusal unrelated to the Worker existence prerequisite", async () => {
    const f = fixture();
    vi.mocked(f.api.register).mockRejectedValueOnce(new ApiError({ operation: "test.lifecycle" }, "response", { status: 403, confirmedRefusal: true, cause: undefined }));
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    const original = f.store.listOperations().find(operation => operation.kind === "instance")!;
    await expect(f.manager.initializeForControl()).rejects.toThrow("Original management registration remains unresolved or was refused.");
    expect(f.registration).toHaveBeenCalledOnce();
    expect(f.api.register).toHaveBeenCalledOnce();
    expect(f.store.readOperation(original.operationId)).toEqual(original);
  });

  it("does not replace an unresolved registration when the Worker prerequisite is available", async () => {
    const f = fixture();
    vi.mocked(f.api.register).mockRejectedValueOnce(unknown());
    vi.mocked(f.api.resolve).mockRejectedValue(unknown());
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    const original = f.store.listOperations().find(operation => operation.kind === "instance")!;
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    expect(f.registration).toHaveBeenCalledOnce();
    expect(f.api.register).toHaveBeenCalledOnce();
    expect(f.api.operation).toHaveBeenCalledExactlyOnceWith(original.operationId, f.cancellation.signal);
    expect(f.api.resolve).toHaveBeenCalledExactlyOnceWith({ protocolVersion: 1, requestKind: "instance", request: original.request }, f.cancellation.signal);
    expect(f.store.listOperations().filter(operation => operation.kind === "instance")).toEqual([original]);
    expect(f.store.readState().admission).toBe("closed");
  });

  it("keeps the same registration after its committed response is lost during control initialization", async () => {
    const f = fixture(), register = vi.mocked(f.api.register).getMockImplementation()!;
    vi.mocked(f.api.register).mockImplementation(async request => { await register(request); throw unknown(); });
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    const original = f.store.listOperations().find(operation => operation.kind === "instance")!;
    expect(original.status).toBe("unknown");
    const binding = await f.manager.initializeForControl();
    expect(binding.instanceEpoch).toBe("1");
    expect(f.api.register).toHaveBeenCalledOnce();
    expect(f.registration).toHaveBeenCalledOnce();
    expect(f.api.operation).toHaveBeenCalledWith(original.operationId, f.cancellation.signal);
    expect(f.store.readOperation(original.operationId)?.status).toBe("confirmed");
  });

  it("refuses explicit control immediately when a local veto exists", async () => {
    const f = fixture(); f.store.closeAdmission({ operationId: id(42), local: true });
    await expect(f.manager.initializeForControl()).rejects.toThrow("explicit resume is required");
    expect(f.api.register).not.toHaveBeenCalled(); expect(f.api.activate).not.toHaveBeenCalled();
    expect(f.store.readState()).toMatchObject({ localVeto: true, admission: "closed" });
  });

  it("does not rewrite a successful remote receipt as unknown after SQLite save fails", async () => {
    const f = fixture(); await start(f); await disable(f);
    const holder = new Database(f.file), writes = vi.spyOn(f.store, "recordOperation");
    f.onActivation(request => { if (!("action" in request)) holder.exec("BEGIN IMMEDIATE"); });
    try {
      await expect(f.manager.resume(id(22))).rejects.toThrow();
      holder.exec("ROLLBACK");
      type OperationWrite = Parameters<typeof f.store.recordOperation>[0];
      const phases: OperationWrite[] = writes.mock.calls.map(([request]: [OperationWrite]) => request).filter((request: OperationWrite) => request.operationId === id(22) && request.phase === "activation");
      expect(phases.map(request => request.status)).toEqual(["submitted", "confirmed"]);
      expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "submitted" });
      expect(f.store.readState().admission).toBe("closed");
    } finally { if (holder.inTransaction) holder.exec("ROLLBACK"); holder.close(); }
  }, 5000);

  it("does not erase normal reconnect eligibility when the root aborts a cloud read", async () => {
    const f = fixture(); await start(f);
    const gate = deferred<LifecycleResource>(); f.blockReads(gate.promise); await f.readStarted.promise;
    f.store.closeForRestart(); f.cancellation.abort(new Error("Normal Worker shutdown"));
    await f.manager.close();
    expect(f.store.readState()).toMatchObject({ phase: "accepting", admission: "closed", localVeto: false, activation: { action: "bootstrap" } });
  }, 5000);
});
