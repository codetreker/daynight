import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../src/api/client.js";
import { lifecycleRequestHash, parseLifecycleObservationEnvelope, type LifecycleActivationRequest, type LifecycleActivationReceipt, type LifecycleInstanceRequest, type LifecycleInstanceReceipt, type LifecycleIntentRequest, type LifecycleIntentReceipt, type LifecycleObservationEnvelope, type LifecycleOperationResult, type LifecycleResolveRequest, type LifecycleResource } from "../../../src/api/worker-lifecycle.js";
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

  it("refreshes a newer disable observation while original owners keep failing stop and save", async () => {
    const f = fixture(); await f.manager.initializeForControl();
    const owner = control(), failure: OwnerStopResult[] = [{ ...stopped[0]!, stop: "unknown", save: "failed" }];
    owner.stop = vi.fn(async () => failure);
    owner.reconcile = vi.fn(async () => failure);
    f.manager.attach(owner);
    const local = openLifecycleStore({ file: f.file, identity });
    try {
      local.reserveExecution({ binding: f.manager.binding(), resourceId: id(70), ownerKind: "task", identity: { taskId: id(71) }, operationId: id(72) });
      local.recordResource({ resourceId: id(70), stage: "unknown", saveState: "failed", error: "Owner has not joined" });
      local.closeAdmission({ operationId: id(20), local: true });
      const original = local.readResource(id(70));
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: "1", source: "web", localEpoch: null, originOperationId: null });
      const reports = vi.mocked(f.api.report).mock.calls.length, recoveries = f.resources.mock.calls.length;
      f.manager.start();
      await expect.poll(() => f.cloud().observation, { timeout: 2500 }).toMatchObject({ operationId: id(24), intentVersion: "2", observation: {
        phase: "blocked", stop: "unknown", save: "pending", inventoryComplete: false, errorCode: "stop_unknown",
        resources: [expect.objectContaining({ resourceId: id(70), stage: "unknown", stop: "unknown", save: "failed" })],
      } });
      const sequence = BigInt(f.cloud().observation!.reportSequence);
      await expect.poll(() => BigInt(f.cloud().observation!.reportSequence), { timeout: 3500 }).toBeGreaterThan(sequence);
      expect(local.readState()).toMatchObject({ admission: "closed", desired: "disabled", intentVersion: "2", phase: "blocked", stop: "unknown", inventoryComplete: false });
      expect(local.readResource(id(70))).toEqual(original);
      expect(vi.mocked(f.api.report).mock.calls.slice(reports).every(([request]) => request.observation.stop !== "confirmed" && request.observation.phase !== "disabled")).toBe(true);
      expect(vi.mocked(owner.reconcile).mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(f.resources).toHaveBeenCalledTimes(recoveries);
      expect(f.api.activate).toHaveBeenCalledOnce();
      expect(owner.rebuild).not.toHaveBeenCalled();
    } finally { local.close(); }
  }, 6000);

  it("reports a newer disable while a lost resume intent lookup remains unavailable", async () => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const owner = control(); f.manager.attach(owner);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => {
      const receipt = await intent(request);
      if (request.operationId === id(22)) throw unknown();
      return receipt;
    });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const local = openLifecycleStore({ file: f.file, identity });
    const original = local.readOperation(id(22));
    expect(original).toMatchObject({ status: "unknown", request: { action: "resume", expectedVersion: "2" } });
    const operation = vi.mocked(f.api.operation).getMockImplementation()!, lookup = deferred<void>();
    let available = false;
    vi.mocked(f.api.operation).mockImplementation(async operationId => {
      if (operationId === id(22) && !available) { lookup.resolve(); throw unknown(); }
      return operation(operationId);
    });
    try {
      f.manager.start();
      await waitSignal(lookup.promise, AbortSignal.timeout(2500));
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: "3", source: "web", localEpoch: null, originOperationId: null });
      await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ operationId: id(24), intentVersion: "4", observation: { phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true } });
      const sequence = BigInt(f.cloud().observation!.reportSequence);
      await expect.poll(() => BigInt(f.cloud().observation!.reportSequence), { timeout: 3500 }).toBeGreaterThan(sequence);
      expect(local.readState()).toMatchObject({ admission: "closed", desired: "disabled", intentVersion: "4", localVeto: true, activation: null });
      expect(local.readOperation(id(22))).toEqual(original);
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
      expect(f.api.resolve).not.toHaveBeenCalled();
      expect(owner.rebuild).not.toHaveBeenCalled();
      available = true;
      await expect.poll(() => local.readOperation(id(22)), { timeout: 3500 }).toMatchObject({ status: "confirmed", request: original!.request, requestHash: original!.requestHash });
      expect(local.readState().admission).toBe("closed");
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(owner.rebuild).not.toHaveBeenCalled();
      await f.api.intent({ protocolVersion: 1, operationId: id(25), action: "resume", expectedVersion: "4", source: "web", localEpoch: "2", instanceEpoch: "1" });
      await waitSignal(f.manager.waitForAdmission(), AbortSignal.timeout(3500));
      expect(local.readState()).toMatchObject({ admission: "open", intentVersion: "5", localVeto: false });
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(1);
      expect(owner.rebuild).toHaveBeenCalledOnce();
    } finally { local.close(); }
  }, 12_000);

  it.each(["resource reconciliation", "owner stop"] as const)("registers a replacement and reports current authority while %s remains unavailable", async failure => {
    const f = fixture(); await f.manager.initializeForControl();
    f.store.reserveExecution({ binding: f.manager.binding(), resourceId: id(70), ownerKind: "task", identity: { taskId: id(71) }, operationId: id(72) });
    f.store.recordResource({ resourceId: id(70), stage: "unknown", saveState: "failed", error: "Original owner has not joined" });
    const original = f.store.readResource(id(70));
    f.store.closeForRestart(); f.cancellation.abort(); await f.manager.close();
    const local = openLifecycleStore({ file: f.file, identity }), cancellation = new AbortController();
    const owner = control(), release = deferred<OwnerStopResult[]>();
    let recovered = false;
    if (failure === "owner stop") {
      owner.stop = vi.fn(async () => release.promise);
      owner.reconcile = vi.fn<typeof owner.reconcile>(async () => recovered ? stopped : [{ ...stopped[0]!, stop: "unknown", save: "failed" }]);
    }
    const resources = vi.fn(async () => {
      if (failure === "resource reconciliation" && !recovered) throw new Error("Original native resource remains unavailable");
      if (recovered) local.recordResource({ resourceId: id(70), stage: "stopped", stopProof: { joined: true }, saveState: "durable", error: null });
    });
    const replacement = createLifecycleManager({ store: local, api: f.api, platform: "macos", signal: cancellation.signal,
      reconcileResources: resources, reportError: error => f.errors.push(error) });
    replacement.attach(owner);
    const activations = vi.mocked(f.api.activate).mock.calls.length;
    try {
      replacement.start();
      await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ instanceEpoch: "2", intentVersion: "1", operationId: null,
        observation: { phase: "blocked", stop: "unknown", inventoryComplete: false,
          resources: [expect.objectContaining({ resourceId: id(70), stage: "unknown", save: "failed" })] } });
      expect(f.api.register).toHaveBeenCalledTimes(2);
      expect(local.readResource(id(70))).toEqual(original);
      if (failure === "owner stop") {
        expect(owner.stop).toHaveBeenCalled();
        expect(owner.reconcile).toHaveBeenCalled();
      }
      expect(resources).toHaveBeenCalled();
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: "1", source: "web", localEpoch: null, originOperationId: null });
      await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ instanceEpoch: "2", intentVersion: "2", operationId: id(24),
        observation: { phase: "blocked", stop: "unknown", inventoryComplete: false } });
      const sequence = BigInt(f.cloud().observation!.reportSequence);
      await expect.poll(() => BigInt(f.cloud().observation!.reportSequence), { timeout: 3500 }).toBeGreaterThan(sequence);
      expect(local.readResource(id(70))).toEqual(original);
      expect(local.readState()).toMatchObject({ admission: "closed", instanceEpoch: "2", intentVersion: "2", desired: "disabled" });
      expect(f.api.activate).toHaveBeenCalledTimes(activations);
      expect(owner.rebuild).not.toHaveBeenCalled();
      expect(f.api.register).toHaveBeenCalledTimes(2);
      recovered = true; release.resolve(stopped);
      await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ instanceEpoch: "2", intentVersion: "2", operationId: id(24),
        observation: { phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true } });
      expect(local.readResource(id(70))).toMatchObject({ identity: original!.identity, stage: "stopped", saveState: "durable" });
      expect(f.api.register).toHaveBeenCalledTimes(2);
      expect(f.api.activate).toHaveBeenCalledTimes(activations);
      expect(owner.rebuild).not.toHaveBeenCalled();
    } finally { release.resolve(stopped); cancellation.abort(); await replacement.close(); local.close(); }
  }, 15_000);

  it.each(["lookup", "resolution"] as const)("reports a new disable during replacement initialization and retains a newer Web resume across unavailable original %s", async boundary => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => { const receipt = await intent(request); if (request.operationId === id(22)) throw unknown(); return receipt; });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const original = f.store.readOperation(id(22))!;
    expect(original).toMatchObject({ status: "unknown", request: { instanceEpoch: "1", expectedVersion: "2" } });
    f.cancellation.abort(); await f.manager.close();
    const local = openLifecycleStore({ file: f.file, identity }), cancellation = new AbortController();
    const operation = vi.mocked(f.api.operation).getMockImplementation()!, lookup = deferred<void>();
    let available = false;
    vi.mocked(f.api.operation).mockImplementation(async operationId => {
      if (operationId !== id(22)) return operation(operationId);
      // A concurrent Web intent may supersede the report before this lookup.
      // Require reporting the locally observed authority, not the later cloud version.
      expect(vi.mocked(f.api.report).mock.calls.at(-1)?.[0]).toMatchObject({ instanceEpoch: "2", intentVersion: local.readState().intentVersion });
      lookup.resolve();
      if (boundary === "resolution") throw missing();
      if (!available) throw unknown();
      return operation(operationId);
    });
    vi.mocked(f.api.resolve).mockImplementation(async request => {
      expect(request).toEqual({ protocolVersion: 1, requestKind: "intent", request: original.request });
      if (!available) throw unknown();
      return operation(request.request.operationId);
    });
    const owner = control(), replacement = createLifecycleManager({ store: local, api: f.api, platform: "macos", signal: cancellation.signal,
      reconcileResources: f.resources, reportError: error => f.errors.push(error) });
    replacement.attach(owner);
    const activations = vi.mocked(f.api.activate).mock.calls.length;
    try {
      replacement.start();
      await waitSignal(lookup.promise, AbortSignal.timeout(3500));
      expect(f.api.register).toHaveBeenCalledTimes(2);
      expect(local.readOperation(id(22))).toEqual(original);
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: "3", source: "web", localEpoch: null, originOperationId: null });
      await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ instanceEpoch: "2", intentVersion: "4", operationId: id(24),
        observation: { phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true } });
      const sequence = BigInt(f.cloud().observation!.reportSequence);
      await expect.poll(() => BigInt(f.cloud().observation!.reportSequence), { timeout: 3500 }).toBeGreaterThan(sequence);
      expect(local.readOperation(id(22))).toEqual(original);
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(local.readState()).toMatchObject({ admission: "closed", instanceEpoch: "2", intentVersion: "4", localVeto: true });
      expect(f.api.activate).toHaveBeenCalledTimes(activations);
      expect(owner.rebuild).not.toHaveBeenCalled();
      expect(f.api.register).toHaveBeenCalledTimes(2);
      const resumeEpoch = local.readState().localEpoch;
      const resumeSubmitted = deferred<void>();
      const disablesBeforeResume = vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.action === "disable").map(([request]) => request);
      f.onReport(async envelope => {
        if (envelope.instanceEpoch !== "2" || envelope.intentVersion !== "4" || envelope.operationId !== id(24)
          || envelope.observation.phase !== "disabled" || envelope.observation.stop !== "confirmed" || envelope.observation.save !== "durable"
          || !envelope.observation.inventoryComplete || ![null, "resume_interrupted", "upload_failed"].includes(envelope.observation.errorCode)) return;
        // The fixture has published this clean stop. Submit before failed lookup
        // reporting can replace it, preserving the API's resume prerequisites.
        f.onReport(undefined);
        try {
          expect(available).toBe(false);
          expect(local.readOperation(id(22))).toEqual(original);
          expect(local.readState()).toMatchObject({ instanceEpoch: "2", localEpoch: resumeEpoch, localVeto: true, admission: "closed" });
          await f.api.intent({ protocolVersion: 1, operationId: id(25), action: "resume", expectedVersion: "4", source: "web", localEpoch: resumeEpoch, instanceEpoch: "2" });
          resumeSubmitted.resolve();
        } catch (error) { resumeSubmitted.reject(error); throw error; }
      });
      await waitSignal(resumeSubmitted.promise, AbortSignal.timeout(4500));
      await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ instanceEpoch: "2", intentVersion: "5", operationId: id(25),
        observation: { phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true } });
      const resumedSequence = BigInt(f.cloud().observation!.reportSequence);
      await expect.poll(() => BigInt(f.cloud().observation!.reportSequence), { timeout: 3500 }).toBeGreaterThan(resumedSequence);
      expect(local.readOperation(id(22))).toEqual(original);
      expect(local.readState()).toMatchObject({ admission: "closed", intentVersion: "5", localEpoch: resumeEpoch, localVeto: true });
      expect(f.api.register).toHaveBeenCalledTimes(2);
      expect(f.api.activate).toHaveBeenCalledTimes(activations);
      expect(owner.rebuild).not.toHaveBeenCalled();
      available = true;
      await expect.poll(() => local.readOperation(id(22)), { timeout: 3500 }).toMatchObject({ status: "confirmed", request: original.request, requestHash: original.requestHash });
      expect(f.api.operation).toHaveBeenCalledWith(id(22), cancellation.signal);
      if (boundary === "resolution") expect(f.api.resolve).toHaveBeenCalledWith({ protocolVersion: 1, requestKind: "intent", request: original.request }, cancellation.signal);
      else expect(f.api.resolve).not.toHaveBeenCalled();
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
      await waitSignal(replacement.waitForAdmission(), AbortSignal.timeout(4500));
      expect(f.api.register).toHaveBeenCalledTimes(2);
      expect(f.api.activate).toHaveBeenCalledTimes(activations + 1);
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(25))).toEqual([
        [expect.objectContaining({ operationId: id(25), instanceEpoch: "2", intentVersion: "5", localEpoch: resumeEpoch }), cancellation.signal],
      ]);
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(local.readOperation(id(25), "activation")).toMatchObject({ status: "confirmed" });
      expect(local.readState()).toMatchObject({ admission: "open", instanceEpoch: "2", intentVersion: "5", localEpoch: resumeEpoch, localVeto: false });
      expect(f.cloud()).toMatchObject({ operationId: id(25), intentVersion: "5", desired: "enabled", admission: "open" });
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(1);
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.action === "disable").map(([request]) => request)).toEqual(disablesBeforeResume);
      expect(owner.rebuild).toHaveBeenCalledOnce();
    } finally { f.onReport(undefined); cancellation.abort(); await replacement.close(); local.close(); }
  }, 25_000);

  it("keeps resumed execution active across polling when an original intent recovers after incomplete initialization", async () => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => {
      const receipt = await intent(request);
      if (request.operationId === id(22)) throw unknown();
      return receipt;
    });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const original = f.store.readOperation(id(22))!;
    expect(original).toMatchObject({ status: "unknown", request: { instanceEpoch: "1", expectedVersion: "2" } });
    f.cancellation.abort(); await f.manager.close();
    const local = openLifecycleStore({ file: f.file, identity }), cancellation = new AbortController();
    const operation = vi.mocked(f.api.operation).getMockImplementation()!, lookupFailure = unknown();
    let available = false, originalLookups = 0;
    f.onReport(envelope => {
      if (envelope.instanceEpoch === "2" && envelope.observation.errorCode === "authority_unavailable") {
        expect(local.readOperation(id(22))).toEqual(original);
        available = true;
      }
    });
    vi.mocked(f.api.operation).mockImplementation(async operationId => {
      if (operationId === id(22)) {
        originalLookups++;
        if (!available) throw lookupFailure;
        expect(vi.mocked(f.api.report).mock.calls.at(-1)?.[0]).toMatchObject({ instanceEpoch: "2", observation: { errorCode: "authority_unavailable" } });
      }
      return operation(operationId);
    });
    const replacement = createLifecycleManager({ store: local, api: f.api, platform: "macos", signal: cancellation.signal,
      reconcileResources: f.resources, reportError: error => f.errors.push(error) });
    try {
      // Initialization reports its unresolved request and returns without execution
      // readiness; the remainder of this same local resume can now resolve it.
      await replacement.resume(id(25));
      expect(originalLookups).toBe(2);
      expect(f.errors).toContain(lookupFailure);
      expect(local.readOperation(id(22))).toMatchObject({ status: "confirmed", request: original.request, requestHash: original.requestHash });
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(local.readOperation(id(25), "activation")).toMatchObject({ status: "confirmed" });
      const binding = replacement.binding();
      expect(local.readState()).toMatchObject({ admission: "open", phase: "accepting", localVeto: false, instanceEpoch: "2", intentVersion: "4" });
      expect(f.cloud()).toMatchObject({ admission: "open", desired: "enabled", operationId: id(25), intentVersion: "4" });
      const owner = control();
      let executionActive = true;
      owner.stop = vi.fn(async () => { executionActive = false; return stopped; });
      owner.reconcile = vi.fn(async () => { executionActive = false; return stopped; });
      replacement.attach(owner);
      f.onReport(undefined);
      const reports = vi.mocked(f.api.report).mock.calls.length, errors = f.errors.length;
      const registrations = vi.mocked(f.api.register).mock.calls.length, activations = vi.mocked(f.api.activate).mock.calls.length;
      replacement.start();
      // start() polls immediately; the second report requires the actual timer tick.
      await expect.poll(() => vi.mocked(f.api.report).mock.calls.length, { timeout: 3500 }).toBeGreaterThanOrEqual(reports + 2);
      expect(executionActive).toBe(true);
      expect(owner.stop).not.toHaveBeenCalled();
      expect(owner.reconcile).not.toHaveBeenCalled();
      expect(owner.rebuild).not.toHaveBeenCalled();
      expect(replacement.binding()).toEqual(binding);
      expect(() => local.assertAdmission(binding)).not.toThrow();
      expect(local.readState()).toMatchObject({ admission: "open", phase: "accepting", localVeto: false, errorCode: null });
      expect(f.cloud()).toMatchObject({ admission: "open", operationId: id(25), intentVersion: "4", observation: {
        instanceEpoch: "2", intentVersion: "4", operationId: id(25), observation: { phase: "accepting", errorCode: null },
      } });
      expect(vi.mocked(f.api.report).mock.calls.slice(reports).every(([envelope]) => envelope.observation.phase === "accepting")).toBe(true);
      expect(f.errors).toHaveLength(errors);
      expect(f.api.register).toHaveBeenCalledTimes(registrations);
      expect(f.api.activate).toHaveBeenCalledTimes(activations);
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(1);
    } finally { f.onReport(undefined); cancellation.abort(); await replacement.close(); local.close(); }
  }, 6000);

  it("fences replacement initialization until the original unknown registration resolves by its frozen identity", async () => {
    const f = fixture(), register = vi.mocked(f.api.register).getMockImplementation()!;
    vi.mocked(f.api.register).mockImplementationOnce(async request => { await register(request); throw unknown(); });
    await expect(f.manager.initializeForControl()).rejects.toThrow();
    const original = f.store.listOperations().find(operation => operation.kind === "instance")!;
    expect(original.status).toBe("unknown");
    f.cancellation.abort(); await f.manager.close();
    const local = openLifecycleStore({ file: f.file, identity }), cancellation = new AbortController();
    let available = false;
    vi.mocked(f.api.operation).mockRejectedValue(missing());
    vi.mocked(f.api.resolve).mockImplementation(async request => {
      expect(request).toEqual({ protocolVersion: 1, requestKind: "instance", request: original.request });
      if (!available) throw unknown();
      return structuredClone(f.receipts.get(original.operationId)!);
    });
    const owner = control(), replacement = createLifecycleManager({ store: local, api: f.api, platform: "macos", signal: cancellation.signal,
      reconcileResources: f.resources, reportError: error => f.errors.push(error) });
    replacement.attach(owner);
    try {
      // Matching live authority is deliberately available, but cannot prove the original write's outcome.
      expect(await f.api.read()).toMatchObject({ instance: { instanceId: vi.mocked(f.api.register).mock.calls[0]![0].instanceId, instanceEpoch: "1" } });
      replacement.start();
      await expect.poll(() => vi.mocked(f.api.resolve).mock.calls.length, { timeout: 3500 }).toBeGreaterThanOrEqual(2);
      expect(local.readOperation(original.operationId)).toEqual(original);
      expect(local.listOperations().filter(operation => operation.kind === "instance")).toEqual([original]);
      expect(local.readState()).toMatchObject({ admission: "closed", instanceEpoch: null });
      expect(f.api.register).toHaveBeenCalledOnce();
      expect(f.api.report).not.toHaveBeenCalled();
      expect(f.api.activate).not.toHaveBeenCalled();
      expect(owner.rebuild).not.toHaveBeenCalled();
      available = true;
      await waitSignal(replacement.waitForAdmission(), AbortSignal.timeout(3500));
      expect(local.readOperation(original.operationId)).toMatchObject({ status: "confirmed", request: original.request, requestHash: original.requestHash });
      expect(f.api.operation).toHaveBeenCalledWith(original.operationId, cancellation.signal);
      expect(f.api.register).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.api.register).mock.calls[1]![0]).toMatchObject({ previousInstanceEpoch: "1" });
      expect(vi.mocked(f.api.register).mock.calls[1]![0].operationId).not.toBe(original.operationId);
      expect(local.readState()).toMatchObject({ instanceEpoch: "2", admission: "open" });
    } finally { cancellation.abort(); await replacement.close(); local.close(); }
  }, 8000);

  it("automatically settles an uncommitted unknown local resume before activating a different Web resume at the same resulting version", async () => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const owner = control(); f.manager.attach(owner);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => {
      if (request.operationId === id(22)) throw unknown();
      return intent(request);
    });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const local = openLifecycleStore({ file: f.file, identity });
    const original = local.readOperation(id(22))!;
    expect(original).toMatchObject({ status: "unknown", localEpoch: "2", request: { action: "resume", expectedVersion: "2" } });
    expect(f.cloud()).toMatchObject({ desired: "disabled", intentVersion: "2", operationId: id(21) });
    const disabledLookup = deferred<void>(), resumedLookup = deferred<void>();
    let available = false;
    vi.mocked(f.api.resolve).mockImplementation(async request => {
      expect(request).toEqual({ protocolVersion: 1, requestKind: "intent", request: original.request });
      expect(f.cloud().observation).toMatchObject({ operationId: f.cloud().operationId, intentVersion: f.cloud().intentVersion,
        observation: { phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true } });
      if (f.cloud().intentVersion === "2") disabledLookup.resolve(); else resumedLookup.resolve();
      if (!available) throw unknown();
      return { kind: "not_committed", receipt: { protocolVersion: 1, workerId: identity.workerId, operationId: id(22), observedAt: time,
        requestKind: "intent", requestHash: lifecycleRequestHash(request.requestKind, request.request), outcome: "not_committed" } };
    });
    try {
      f.manager.start();
      await waitSignal(disabledLookup.promise, AbortSignal.timeout(2500));
      expect(local.readOperation(id(22))).toEqual(original);
      await f.api.intent({ protocolVersion: 1, operationId: id(25), action: "resume", expectedVersion: "2", source: "web", localEpoch: "2", instanceEpoch: "1" });
      await waitSignal(resumedLookup.promise, AbortSignal.timeout(3500));
      expect(local.readState()).toMatchObject({ admission: "closed", intentVersion: "3", localEpoch: "2", localVeto: true });
      expect(local.readOperation(id(22))).toEqual(original);
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(0);
      expect(owner.rebuild).not.toHaveBeenCalled();
      available = true;
      await waitSignal(f.manager.waitForAdmission(), AbortSignal.timeout(3500));
      expect(local.readOperation(id(22))).toMatchObject({ status: "rejected", request: original.request, requestHash: original.requestHash,
        receipt: { outcome: "not_committed", requestKind: "intent", requestHash: lifecycleRequestHash("intent", original.request) } });
      expect(local.readState()).toMatchObject({ admission: "open", intentVersion: "3", localVeto: false });
      expect(local.readOperation(id(22), "activation")).toBeNull();
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(1);
      expect(owner.rebuild).toHaveBeenCalledOnce();
    } finally { local.close(); }
  }, 10_000);

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

  it("continues a committed resume after losing its intent response without replacing or resending the request", async () => {
    const f = fixture(); await start(f); await disable(f);
    const owner = control(); f.manager.attach(owner);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => { const receipt = await intent(request); if (request.operationId === id(22)) throw unknown(); return receipt; });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const original = f.store.readOperation(id(22))!;
    expect(original).toMatchObject({ status: "unknown", request: { action: "resume", localEpoch: "2", expectedVersion: "2" } });
    expect(f.store.readState().admission).toBe("closed");
    await f.manager.waitForAdmission();
    expect(f.store.readOperation(id(22))).toMatchObject({ status: "confirmed", request: original.request, requestHash: original.requestHash });
    expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "confirmed" });
    expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
    expect(owner.rebuild).toHaveBeenCalledOnce();
  }, 5000);

  it.each([false, true])("reports a superseding remote disable after activation (lost response: %s) and permits a new remote resume", async lostResponse => {
    const f = fixture(); await start(f); await disable(f);
    const owner = control(); f.manager.attach(owner);
    f.onActivation(async request => {
      if (request.operationId !== id(22)) return;
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: request.intentVersion, source: "web", localEpoch: null, originOperationId: null });
      if (lostResponse) throw unknown();
    });
    const resume = f.manager.resume(id(22));
    if (lostResponse) await expect(resume).rejects.toThrow(); else await resume;
    await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ operationId: id(24), intentVersion: "4", observation: { phase: "disabled", stop: "confirmed", save: "durable", inventoryComplete: true } });
    await expect.poll(() => f.store.readOperation(id(22), "activation"), { timeout: 3500 }).toMatchObject({ status: "confirmed", receipt: { intentVersion: "3", admission: "open" } });
    expect(f.store.readState()).toMatchObject({ admission: "closed", desired: "disabled", intentVersion: "4", phase: "disabled", activation: null, localEpoch: "2", localVeto: true });
    expect(owner.rebuild).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
    await f.api.intent({ protocolVersion: 1, operationId: id(25), action: "resume", expectedVersion: "4", source: "web", localEpoch: "2", instanceEpoch: "1" });
    await f.manager.waitForAdmission();
    expect(f.store.readState()).toMatchObject({ admission: "open", intentVersion: "5", localVeto: false });
    expect(owner.rebuild).toHaveBeenCalledOnce();
  }, 5000);

  it("automatically settles a retired unknown activation before a later remote resume can open admission", async () => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const owner = control(); f.manager.attach(owner);
    f.onActivation(async request => {
      if (request.operationId !== id(22)) return;
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: request.intentVersion, source: "web", localEpoch: null, originOperationId: null });
      throw unknown();
    });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const original = f.store.readOperation(id(22), "activation");
    expect(original).toMatchObject({ status: "unknown" });
    const operation = vi.mocked(f.api.operation).getMockImplementation()!;
    const blockedResume = deferred<void>();
    let available = false;
    vi.mocked(f.api.operation).mockImplementation(async operationId => {
      if (operationId === id(22) && !available) {
        // A Web resume submitted by the report hook may already have superseded
        // that observation. The lookup follows the locally observed version.
        const reported = vi.mocked(f.api.report).mock.calls.at(-1)?.[0];
        expect(reported).toMatchObject({ intentVersion: f.store.readState().intentVersion, observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
        if (reported?.intentVersion === "5") blockedResume.resolve();
        throw unknown();
      }
      return operation(operationId);
    });
    f.manager.start();
    await expect.poll(() => f.cloud().observation, { timeout: 2500 }).toMatchObject({ operationId: id(24), intentVersion: "4", observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
    const sequence = BigInt(f.cloud().observation!.reportSequence);
    await expect.poll(() => BigInt(f.cloud().observation!.reportSequence), { timeout: 3500 }).toBeGreaterThan(sequence);
    expect(f.store.readOperation(id(22), "activation")).toEqual(original);
    expect(f.api.operation).toHaveBeenCalledWith(id(22), f.cancellation.signal);
    const resumeSubmitted = deferred<void>();
    f.onReport(async envelope => {
      if (envelope.instanceEpoch !== "1" || envelope.intentVersion !== "4" || envelope.operationId !== id(24)
        || envelope.observation.phase !== "disabled" || envelope.observation.stop !== "confirmed" || envelope.observation.save !== "durable"
        || !envelope.observation.inventoryComplete || ![null, "resume_interrupted", "upload_failed"].includes(envelope.observation.errorCode)) return;
      // Submit while the clean stop is published, before the unavailable original
      // activation lookup can replace it with an ineligible failure observation.
      f.onReport(undefined);
      try {
        expect(available).toBe(false);
        expect(f.store.readOperation(id(22), "activation")).toEqual(original);
        await f.api.intent({ protocolVersion: 1, operationId: id(25), action: "resume", expectedVersion: "4", source: "web", localEpoch: "2", instanceEpoch: "1" });
        resumeSubmitted.resolve();
      } catch (error) { resumeSubmitted.reject(error); throw error; }
    });
    await waitSignal(resumeSubmitted.promise, AbortSignal.timeout(2500));
    await waitSignal(blockedResume.promise, AbortSignal.timeout(2500));
    expect(f.cloud().observation).toMatchObject({ operationId: id(25), intentVersion: "5", observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
    expect(f.store.readState()).toMatchObject({ admission: "closed", localVeto: true, activation: null, intentVersion: "5" });
    expect(f.store.readOperation(id(22), "activation")).toEqual(original);
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(0);
    expect(owner.rebuild).not.toHaveBeenCalled();
    available = true;
    await waitSignal(f.manager.waitForAdmission(), AbortSignal.timeout(3500));
    expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "confirmed", request: original!.request, requestHash: original!.requestHash, receipt: { intentVersion: "3", admission: "open" } });
    expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false, intentVersion: "5" });
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(1);
    expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(25))).toHaveLength(1);
    expect(f.api.resolve).not.toHaveBeenCalled();
    expect(owner.rebuild).toHaveBeenCalledOnce();
  }, 10_000);

  it.each(["bootstrap", "resume"] as const)("retires %s when cloud disable commits before its activation report", async action => {
    const f = fixture();
    if (action === "resume") { await f.manager.initializeForControl(); await disable(f); }
    const owner = control(); f.manager.attach(owner);
    const entered = deferred<LifecycleObservationEnvelope>(), release = deferred<void>();
    const report = vi.mocked(f.api.report).getMockImplementation()!;
    const refusal = new ApiError({ operation: "test.lifecycle" }, "response", { status: 409, serverError: { code: "stale_intent", message: "Intent was superseded.", requestId: id(99) }, confirmedRefusal: true, cause: undefined });
    vi.mocked(f.api.report).mockImplementation(async envelope => {
      if (envelope.observation.phase === "resuming") {
        entered.resolve(envelope); await waitSignal(release.promise, f.cancellation.signal);
        throw refusal;
      }
      return report(envelope);
    });
    const result = (action === "bootstrap" ? f.manager.initializeForControl() : f.manager.resume(id(22))).then(() => null, error => error);
    const local = openLifecycleStore({ file: f.file, identity });
    try {
      const envelope = await waitSignal(entered.promise, AbortSignal.timeout(2000));
      const activation = local.readState().activation!;
      expect(local.readState()).toMatchObject({ phase: "resuming", admission: "closed" });
      expect(local.readOperation(activation.operationId, action === "resume" ? "activation" : "primary")).toBeNull();
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: envelope.intentVersion, source: "web", localEpoch: null, originOperationId: null });
      release.resolve();
      expect(await result).toBe(refusal);
      const outbox = local.listOutbox().find(row => row.uploadState === "unknown")!;
      expect(outbox).toMatchObject({ intentVersion: envelope.intentVersion });
      await f.manager.reconcile();
      expect(local.readState()).toMatchObject({ phase: "disabled", desired: "disabled", admission: "closed", activation: null, stop: "confirmed", save: "durable", inventoryComplete: true });
      expect(f.cloud().observation).toMatchObject({ operationId: id(24), intentVersion: String(BigInt(envelope.intentVersion) + 1n), observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
      expect(local.readOutboxHistory(outbox.id)).toMatchObject({ uploadState: "covered" });
      expect(vi.mocked(f.api.report).mock.calls.filter(([request]) => request.reportSequence === envelope.reportSequence)).toHaveLength(1);
      expect(local.readOperation(activation.operationId, action === "resume" ? "activation" : "primary")).toBeNull();
      expect(f.api.activate).toHaveBeenCalledTimes(action === "resume" ? 1 : 0);
      expect(owner.rebuild).not.toHaveBeenCalled();
    } finally { release.resolve(); await result; local.close(); }
  });

  it.each([
    { status: "unknown", laterVeto: false }, { status: "unknown", laterVeto: true },
    { status: "rejected", laterVeto: false }, { status: "rejected", laterVeto: true },
  ] as const)("retires a superseded $status activation while preserving its outcome (later veto: $laterVeto)", async ({ status, laterVeto }) => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const owner = control(); f.manager.attach(owner);
    const failure = status === "unknown" ? unknown() : new ApiError({ operation: "test.lifecycle" }, "response", { status: 409, serverError: { code: "stale_intent", message: "Intent was superseded.", requestId: id(99) }, confirmedRefusal: true, cause: undefined });
    vi.mocked(f.api.activate).mockRejectedValueOnce(failure);
    await expect(f.manager.resume(id(22))).rejects.toBe(failure);
    const original = f.store.readOperation(id(22), "activation");
    expect(original).toMatchObject({ status });
    const entered = deferred<void>(), release = deferred<void>();
    const read = vi.mocked(f.api.read).getMockImplementation()!;
    vi.mocked(f.api.read).mockImplementationOnce(async () => {
      entered.resolve(); await waitSignal(release.promise, f.cancellation.signal); return read();
    });
    const local = openLifecycleStore({ file: f.file, identity });
    const result = f.manager.reconcile();
    try {
      await waitSignal(entered.promise, AbortSignal.timeout(2000));
      const veto = laterVeto ? local.closeAdmission({ operationId: id(26), local: true }) : local.readState();
      await f.api.intent({ protocolVersion: 1, operationId: id(24), action: "disable", expectedVersion: "3", source: "web", localEpoch: null, originOperationId: null });
      release.resolve(); await result;
      expect(local.readOperation(id(22), "activation")).toEqual(original);
      expect(local.readState()).toMatchObject({ localEpoch: veto.localEpoch, localVeto: true, admission: "closed", phase: "disabled", activation: null, intentVersion: "4", stop: "confirmed", save: "durable" });
      expect(f.cloud().observation).toMatchObject({ operationId: id(24), intentVersion: "4", localEpoch: veto.localEpoch, observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
      expect(f.api.operation).not.toHaveBeenCalledWith(id(22), f.cancellation.signal);
      expect(f.api.resolve).not.toHaveBeenCalled();
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
      expect(owner.rebuild).not.toHaveBeenCalled();
    } finally { release.resolve(); await result; local.close(); }
  });

  it.each(["unavailable", "same intent", "newer enabled", "different instance"] as const)("retains an unknown activation when authority is %s", async boundary => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    vi.mocked(f.api.activate).mockRejectedValueOnce(unknown());
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    const activation = f.store.readState().activation, original = f.store.readOperation(id(22), "activation");
    const failure = unknown();
    vi.mocked(f.api.operation).mockRejectedValue(failure);
    if (boundary === "unavailable") vi.mocked(f.api.read).mockRejectedValueOnce(failure);
    else if (boundary === "same intent") f.setCloud({ desired: "disabled", admission: "closed" });
    else if (boundary === "newer enabled") f.setCloud({ intentVersion: "4", desired: "enabled", admission: "closed" });
    else f.setCloud({ intentVersion: "4", desired: "disabled", admission: "closed", instance: { instanceId: id(50), instanceEpoch: "2" } });
    await expect(f.manager.reconcile()).rejects.toBe(failure);
    expect(f.store.readState()).toMatchObject({ phase: "resuming", admission: "closed", activation });
    expect(f.store.readOperation(id(22), "activation")).toEqual(original);
    expect(f.api.resolve).not.toHaveBeenCalled();
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
  });

  it("retains a committed activation while its final authority read is unavailable", async () => {
    const f = fixture(); await start(f); await disable(f);
    const owner = control(); f.manager.attach(owner);
    const failure = unknown();
    f.onActivation(request => { if (request.operationId === id(22)) vi.mocked(f.api.read).mockRejectedValueOnce(failure); });
    await expect(f.manager.resume(id(22))).rejects.toBe(failure);
    expect(f.store.readState()).toMatchObject({ admission: "closed", phase: "resuming", activation: { operationId: id(22) } });
    expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "confirmed" });
    await f.manager.reconcile();
    expect(f.store.readState().admission).toBe("open");
    expect(owner.rebuild).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
  });

  it("retries a remote resume lookup after observing its version without inventing a local request", async () => {
    const f = fixture(); await start(f); await disable(f);
    await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ operationId: id(21), intentVersion: "2", observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
    await f.api.intent({ protocolVersion: 1, operationId: id(22), action: "resume", expectedVersion: "2", source: "web", localEpoch: "2", instanceEpoch: "1" });
    const operation = vi.mocked(f.api.operation).getMockImplementation()!, failure = unknown(), failed = deferred<void>();
    vi.mocked(f.api.operation).mockImplementationOnce(async operationId => {
      expect(operationId).toBe(id(22)); failed.resolve(); throw failure;
    }).mockImplementation(operation);
    await failed.promise;
    expect(f.store.readState()).toMatchObject({ admission: "closed", intentVersion: "3" });
    await f.manager.waitForAdmission();
    expect(f.errors).toContain(failure);
    expect(f.store.readOperation(id(22))).toMatchObject({ status: "confirmed", request: null, localEpoch: "2" });
    expect(f.cloud()).toMatchObject({ intentVersion: "3", desired: "enabled", admission: "open", operationId: id(22) });
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
  }, 5000);

  it("retains an accepted resume when preparing its activation fails before the durable continuation", async () => {
    const f = fixture(); await start(f); await disable(f);
    const failure = new Error("Activation preparation unavailable"), prepare = vi.spyOn(f.store, "prepareActivation");
    prepare.mockImplementationOnce(() => { throw failure; });
    await expect(f.manager.resume(id(22))).rejects.toBe(failure);
    expect(f.store.readState()).toMatchObject({ admission: "closed", intentVersion: "3", activation: null });
    expect(f.store.readOperation(id(22))).toMatchObject({ status: "confirmed" });
    await f.manager.waitForAdmission();
    expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
    expect(f.store.readState()).toMatchObject({ admission: "open", scopeGeneration: "2" });
  }, 5000);

  it("reconciles a remote resume placeholder after saving its confirmed receipt fails", async () => {
    const f = fixture(); await start(f); await disable(f);
    await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ operationId: id(21), intentVersion: "2", observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
    await f.api.intent({ protocolVersion: 1, operationId: id(22), action: "resume", expectedVersion: "2", source: "web", localEpoch: "2", instanceEpoch: "1" });
    const failure = new Error("Resume receipt persistence unavailable"), record = f.store.recordOperation, failed = deferred<void>();
    let fail = true;
    vi.spyOn(f.store, "recordOperation").mockImplementation(request => {
      if (fail && request.operationId === id(22) && request.status === "confirmed") { fail = false; failed.resolve(); throw failure; }
      return record(request);
    });
    await failed.promise;
    expect(f.store.readOperation(id(22))).toMatchObject({ status: "prepared", request: null, receipt: null, localEpoch: "2" });
    expect(f.store.readState().admission).toBe("closed");
    await f.manager.waitForAdmission();
    expect(f.errors).toContain(failure);
    expect(f.store.readOperation(id(22))).toMatchObject({ status: "confirmed", request: null, receipt: { operationId: id(22), action: "resume", intentVersion: "3" } });
    expect(f.cloud()).toMatchObject({ intentVersion: "3", desired: "enabled", admission: "open", operationId: id(22) });
    expect(vi.mocked(f.api.operation).mock.calls.filter(([operationId]) => operationId === id(22))).toHaveLength(2);
    expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(1);
  }, 5000);

  it("does not apply a remote resume to a local veto added during its operation lookup", async () => {
    const f = fixture(); await start(f); await disable(f);
    await expect.poll(() => f.cloud().observation, { timeout: 3500 }).toMatchObject({ operationId: id(21), intentVersion: "2", observation: { phase: "disabled", stop: "confirmed", save: "durable" } });
    await f.api.intent({ protocolVersion: 1, operationId: id(22), action: "resume", expectedVersion: "2", source: "web", localEpoch: "2", instanceEpoch: "1" });
    const lookup = deferred<void>(), release = deferred<void>(), operation = vi.mocked(f.api.operation).getMockImplementation()!;
    vi.mocked(f.api.operation).mockImplementation(async operationId => { if (operationId === id(22)) { lookup.resolve(); await release.promise; } return operation(operationId); });
    try {
      await lookup.promise;
      f.store.closeAdmission({ operationId: id(24), local: true });
      release.resolve();
      await expect.poll(() => f.cloud().desired).toBe("disabled");
      expect(f.store.readState()).toMatchObject({ admission: "closed", localEpoch: "3", localVeto: true });
      expect(f.store.readOperation(id(22))).toBeNull();
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(0);
    } finally { release.resolve(); }
  }, 5000);

  it.each(["initialization", "operation lookup", "owner stop", "resource reconciliation", "authority read", "second stop", "report reconciliation", "report upload"] as const)("rejects a resume superseded during %s before sending intent", async boundary => {
    const f = fixture();
    if (boundary === "initialization") f.store.closeAdmission({ operationId: id(20), local: true });
    else { await f.manager.initializeForControl(); await disable(f); }
    const owner = control(); f.manager.attach(owner);
    const entered = deferred<void>(), release = deferred<void>();
    const pause = async () => { entered.resolve(); await waitSignal(release.promise, f.cancellation.signal); };
    if (boundary === "initialization") {
      const register = vi.mocked(f.api.register).getMockImplementation()!;
      vi.mocked(f.api.register).mockImplementationOnce(async request => { await pause(); return register(request); });
    } else if (boundary === "operation lookup") {
      const request = { protocolVersion: 1, operationId: id(21), action: "disable", expectedVersion: "1", source: "local", localEpoch: "2", originOperationId: id(20) };
      f.store.prepareOperation({ operationId: id(21), kind: "intent", request });
      f.store.recordOperation({ operationId: id(21), status: "submitted" });
      f.store.recordOperation({ operationId: id(21), status: "unknown" });
      const operation = vi.mocked(f.api.operation).getMockImplementation()!;
      vi.mocked(f.api.operation).mockImplementationOnce(async operationId => { await pause(); return operation(operationId); });
    } else if (boundary === "owner stop" || boundary === "resource reconciliation") {
      f.store.closeAdmission({ operationId: id(23), local: true });
      if (boundary === "owner stop") vi.mocked(owner.reconcile).mockImplementationOnce(async () => { await pause(); return stopped; });
      else f.resources.mockImplementationOnce(pause);
    } else if (boundary === "authority read") {
      const read = vi.mocked(f.api.read).getMockImplementation()!;
      vi.mocked(f.api.read).mockImplementationOnce(async () => { const cloud = await read(); await pause(); return cloud; });
    } else if (boundary === "second stop") {
      const read = vi.mocked(f.api.read).getMockImplementation()!;
      vi.mocked(f.api.read).mockImplementationOnce(async () => {
        const cloud = await read();
        f.store.markBlocked("authority_unavailable");
        return cloud;
      });
      f.resources.mockImplementationOnce(pause);
    } else if (boundary === "report reconciliation") {
      const envelope = vi.mocked(f.api.report).mock.calls[0]![0];
      f.store.appendOutbox({ id: id(26), instanceEpoch: envelope.instanceEpoch, intentVersion: envelope.intentVersion, reportSequence: "10", payload: { ...envelope, reportSequence: "10" } });
      const read = vi.mocked(f.api.read).getMockImplementation()!;
      vi.mocked(f.api.read).mockImplementationOnce(read).mockImplementationOnce(async () => { const cloud = await read(); await pause(); return cloud; });
    } else f.onReport(pause);
    const originalEpoch = f.store.readState().localEpoch;
    const local = openLifecycleStore({ file: f.file, identity });
    const result = f.manager.resume(id(22)).then(() => null, error => error);
    try {
      await waitSignal(entered.promise, AbortSignal.timeout(2000));
      const veto = local.closeAdmission({ operationId: id(24), local: true });
      expect(veto.localEpoch).toBe(String(BigInt(originalEpoch) + 1n));
      release.resolve();
      expect(await result).toMatchObject({ message: "Worker lifecycle execution binding is stale." });
      expect(local.readState()).toMatchObject({ localEpoch: veto.localEpoch, localVeto: true, admission: "closed", activation: null });
      expect(local.readOperation(id(22))).toBeNull();
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(0);
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(0);
      expect(owner.rebuild).not.toHaveBeenCalled();
      if (boundary === "operation lookup") expect(local.readOperation(id(21))).toMatchObject({ status: "confirmed", localEpoch: originalEpoch });
    } finally { release.resolve(); await result; local.close(); }
  });

  it("freezes resume's epoch before waiting behind another management action", async () => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const entered = deferred<void>(), release = deferred<void>();
    const read = vi.mocked(f.api.read).getMockImplementation()!;
    vi.mocked(f.api.read).mockImplementationOnce(async () => { const cloud = await read(); entered.resolve(); await waitSignal(release.promise, f.cancellation.signal); return cloud; });
    const first = f.manager.resume(id(23)).then(() => null, error => error);
    const local = openLifecycleStore({ file: f.file, identity });
    let result: Promise<unknown> | undefined;
    try {
      await waitSignal(entered.promise, AbortSignal.timeout(2000));
      result = f.manager.resume(id(22)).then(() => null, error => error);
      const veto = local.closeAdmission({ operationId: id(24), local: true });
      release.resolve();
      expect(await first).toMatchObject({ message: "Worker lifecycle execution binding is stale." });
      expect(await result).toMatchObject({ message: "Worker lifecycle execution binding is stale." });
      expect(local.readState()).toMatchObject({ localEpoch: veto.localEpoch, localVeto: true, admission: "closed" });
      expect(local.readOperation(id(22))).toBeNull();
      expect(vi.mocked(f.api.intent).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(0);
    } finally { release.resolve(); await first; await result; local.close(); }
  });

  it.each(["activation report", "activation lookup", "final authority read"] as const)("preserves a newer veto during %s without rebuilding execution", async boundary => {
    const f = fixture(); await f.manager.initializeForControl(); await disable(f);
    const owner = control(); f.manager.attach(owner);
    const entered = deferred<void>(), release = deferred<void>();
    if (boundary === "activation report") f.onReport(async envelope => {
      if (envelope.observation.phase === "resuming") { entered.resolve(); await waitSignal(release.promise, f.cancellation.signal); }
    });
    else if (boundary === "activation lookup") {
      const failure = unknown();
      f.onActivation(() => { throw failure; });
      await expect(f.manager.resume(id(22))).rejects.toBe(failure);
      expect(f.store.readOperation(id(22), "activation")).toMatchObject({ status: "unknown" });
      const operation = vi.mocked(f.api.operation).getMockImplementation()!;
      vi.mocked(f.api.operation).mockImplementationOnce(async operationId => {
        expect(operationId).toBe(id(22));
        entered.resolve(); await waitSignal(release.promise, f.cancellation.signal);
        return operation(operationId);
      });
    } else f.onActivation(() => {
      const read = vi.mocked(f.api.read).getMockImplementation()!;
      vi.mocked(f.api.read).mockImplementationOnce(async () => { const cloud = await read(); entered.resolve(); await waitSignal(release.promise, f.cancellation.signal); return cloud; });
    });
    const local = openLifecycleStore({ file: f.file, identity });
    const result = (boundary === "activation lookup" ? f.manager.reconcile() : f.manager.resume(id(22))).then(() => null, error => error);
    try {
      await waitSignal(entered.promise, AbortSignal.timeout(2000));
      const veto = local.closeAdmission({ operationId: id(24), local: true });
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(local.readState()).toMatchObject({ localEpoch: veto.localEpoch, localVeto: true, admission: "closed", activation: null });
      expect(local.readOperation(id(22))).toMatchObject({ status: "confirmed", localEpoch: "2", request: { localEpoch: "2" } });
      const activations = vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22));
      if (boundary === "activation report") {
        expect(activations).toHaveLength(0);
        expect(local.readOperation(id(22), "activation")).toBeNull();
      } else {
        expect(activations).toHaveLength(1);
        expect(local.readOperation(id(22), "activation")).toMatchObject({ status: "confirmed", request: { localEpoch: "2" } });
      }
      expect(owner.rebuild).not.toHaveBeenCalled();
    } finally { release.resolve(); await result; local.close(); }
  });

  it("settles a lost local resume while preserving a newer local veto", async () => {
    const f = fixture(); await start(f); await disable(f);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => {
      const receipt = await intent(request);
      if (request.operationId === id(22)) { f.store.closeAdmission({ operationId: id(24), local: true }); throw unknown(); }
      return receipt;
    });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    await expect.poll(() => f.cloud().desired).toBe("disabled");
    expect(f.store.readOperation(id(22))).toMatchObject({ status: "confirmed", localEpoch: "2", request: { localEpoch: "2" } });
    expect(f.store.readState()).toMatchObject({ admission: "closed", localEpoch: "3", localVeto: true });
    expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(0);
  }, 5000);

  it("requires a new explicit resume after restarting with a lost intent response", async () => {
    const f = fixture(); await start(f); await disable(f);
    const intent = vi.mocked(f.api.intent).getMockImplementation()!;
    vi.mocked(f.api.intent).mockImplementation(async request => { const receipt = await intent(request); if (request.operationId === id(22)) throw unknown(); return receipt; });
    await expect(f.manager.resume(id(22))).rejects.toThrow();
    f.cancellation.abort(new Error("Management process ended after intent submission")); await f.manager.close();
    const cancellation = new AbortController();
    const replacement = createLifecycleManager({ store: f.store, api: f.api, platform: "macos", signal: cancellation.signal, reconcileResources: f.resources, reportError: error => f.errors.push(error) });
    try {
      replacement.start();
      await expect.poll(() => f.cloud().observation?.instanceEpoch).toBe("2");
      await replacement.reconcile();
      expect(f.store.readOperation(id(22))).toMatchObject({ status: "confirmed", request: { instanceEpoch: "1" } });
      expect(f.store.readState()).toMatchObject({ admission: "closed", localVeto: true, instanceEpoch: "2", intentVersion: "3" });
      expect(vi.mocked(f.api.activate).mock.calls.filter(([request]) => request.operationId === id(22))).toHaveLength(0);
      await replacement.resume(id(25));
      expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false, instanceEpoch: "2" });
    } finally { cancellation.abort(); await replacement.close(); }
  }, 5000);

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
    expect(f.api.activate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: id(61) }), f.cancellation.signal);
    expect(f.store.listOperations().filter(operation => operation.kind === "activation" && operation.phase === "primary")).toEqual([]);
  });

  it("honors a local veto added while the instance registration is pending", async () => {
    const f = fixture(), started = deferred<void>(), release = deferred<void>();
    const register = vi.mocked(f.api.register).getMockImplementation()!;
    vi.mocked(f.api.register).mockImplementation(async request => { started.resolve(); await release.promise; return register(request); });
    const result = f.manager.initializeForControl().then(() => null, error => error);
    try {
      await started.promise;
      f.store.closeAdmission({ operationId: id(62), local: true });
      release.resolve();
      expect(await result).toBeInstanceOf(Error);
      expect(f.store.readState()).toMatchObject({ admission: "closed", localVeto: true, desired: "disabled", phase: "disabled" });
      expect(f.cloud().desired).toBe("disabled");
      expect(f.api.activate).not.toHaveBeenCalled();
      await f.manager.resume(id(63));
      expect(f.store.readState()).toMatchObject({ admission: "open", localVeto: false });
      expect(f.api.register).toHaveBeenCalledOnce();
      expect(f.api.activate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: id(63) }), f.cancellation.signal);
    } finally { release.resolve(); await result; }
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
