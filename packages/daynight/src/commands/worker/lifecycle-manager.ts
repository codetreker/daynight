import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { ApiError } from "../../api/client.js";
import type { WorkerLifecycleClient } from "../../api/worker-lifecycle-client.js";
import type { LifecycleActivationRequest, LifecycleIntentReceipt, LifecycleObservationEnvelope, LifecycleOperationResult, LifecycleResource as CloudResource, LifecycleResolveRequest, LifecycleRecoveryObservation, LifecycleInstanceRequest, LifecycleInstanceReceipt } from "../../api/worker-lifecycle.js";
import { lifecycleRequestHash, parseLifecycleActivationReceipt, parseLifecycleInstanceReceipt, parseLifecycleActivationRequest, parseLifecycleObservationEnvelope } from "../../api/worker-lifecycle.js";
import type { OwnerStopResult } from "./execution-scope.js";
import type { LifecycleActivation, LifecycleBinding, LifecycleJson, LifecycleOperation, LifecycleStore, LifecycleState } from "./lifecycle-store.js";

const json = (value: unknown): LifecycleJson => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? String(item) : item)) as LifecycleJson;
const terminal = (stage: string): boolean => ["stopped", "confirmed", "not_dispatched"].includes(stage);
export type LifecycleExecutionControl = {
  stop(options: { deadline: number }): Promise<OwnerStopResult[]>;
  reconcile(options: { deadline: number }): Promise<OwnerStopResult[]>;
  rebuild(): void;
};
export type LifecycleManagerOptions = {
  store: LifecycleStore; api: WorkerLifecycleClient; platform: "macos" | "linux" | "windows"; signal: AbortSignal;
  reconcileResources(deadline: number): Promise<void>;
  reportError(error: unknown): void;
  ensureWorkerRegistered?(refresh?: boolean): Promise<void>;
  recovery?(): readonly LifecycleRecoveryObservation[];
};

/** Management has no native execution capability; only a verified activation opens a scope. */
export const createLifecycleManager = (options: LifecycleManagerOptions) => {
  const { store, api, signal } = options;
  let control: LifecycleExecutionControl | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let active = false;
  let polling: Promise<void> | undefined;
  let localWatch: Promise<void> | undefined;
  let localStop: Promise<unknown> | undefined;
  let initialized = false;
  let initialization: { before: LifecycleState; request: LifecycleInstanceRequest; receipt?: LifecycleInstanceReceipt } | undefined;
  const normalReconnect = (state: LifecycleState): boolean => state.bootstrapConsumed && !state.localVeto && state.activation !== null
    && state.phase !== "resuming" && (state.errorCode === null || state.errorCode === "authority_unavailable")
    && state.activation.binding.localEpoch === state.localEpoch && state.activation.binding.intentVersion === state.intentVersion
    && state.activation.binding.scopeGeneration === state.scopeGeneration;
  let authorityOperationId: string | null = null;
  let lastLocalStop: { control: LifecycleExecutionControl; epoch: string } | undefined;
  let closedOwner: { control: LifecycleExecutionControl; results: OwnerStopResult[] } | undefined;
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const work = tail.then(action); tail = work.catch(() => undefined); return work;
  };
  const binding = (): LifecycleBinding => {
    const state = store.readState();
    if (state.instanceId === null || state.instanceEpoch === null || state.intentVersion === null) throw new Error("Worker lifecycle has no registered instance authority.");
    return { serverOrigin: state.serverOrigin, userId: state.userId, workerId: state.workerId, instanceId: state.instanceId, instanceEpoch: state.instanceEpoch, localEpoch: state.localEpoch, intentVersion: state.intentVersion, scopeGeneration: state.scopeGeneration };
  };
  const readAuthority = async (): Promise<CloudResource> => {
    const authority = await api.read(signal); authorityOperationId = authority.operationId; return authority;
  };
  const blocked = (error: unknown, code = "authority_unavailable"): void => {
    try { if (code === "authority_unavailable") store.markManagementFailure(); else store.markBlocked(code); } catch (saveError) { options.reportError(saveError); }
    options.reportError(error);
  };
  const send = async <T>(request: LifecycleResolveRequest, action: () => Promise<T>, phase: "primary" | "activation" = "primary"): Promise<T> => {
    const original = store.prepareOperation({ operationId: request.request.operationId, kind: request.requestKind, request: json(request.request), phase,
      ...("originOperationId" in request.request ? { originOperationId: request.request.originOperationId } : {}) });
    if (original.status !== "prepared") throw new Error("Original lifecycle request requires result reconciliation before another dispatch.");
    store.recordOperation({ operationId: original.operationId, phase, status: "submitted" });
    let receipt: T;
    try { receipt = await action(); } catch (error) {
      store.recordOperation({ operationId: original.operationId, phase, status: error instanceof ApiError && error.confirmedRefusal ? "rejected" : "unknown", receipt: error instanceof ApiError && error.confirmedRefusal ? { code: error.code ?? "refused", ...(error.status === undefined ? {} : { status: error.status }) } : null });
      throw error;
    }
    store.recordOperation({ operationId: original.operationId, phase, status: "confirmed", receipt: json(receipt) });
    return receipt;
  };
  const resolveOriginal = async (original: LifecycleOperation): Promise<void> => {
    if (!["submitted", "unknown"].includes(original.status) || original.request === null) return;
    const request = { protocolVersion: 1, requestKind: original.kind, request: original.request } as LifecycleResolveRequest;
    let result: LifecycleOperationResult | undefined;
    try { result = await api.operation(original.operationId, signal); }
    catch (error) { if (!(error instanceof ApiError && error.confirmedRefusal && error.status === 404)) throw error; }
    if (result === undefined || original.phase === "activation" && result.kind === "intent" && result.activationOutcome === "not_started") result = await api.resolve(request, signal);
    const matches = (result: LifecycleOperationResult): boolean => {
      if (result.kind === "not_committed") return result.receipt.requestKind === request.requestKind && result.receipt.requestHash === lifecycleRequestHash(request.requestKind, request.request);
      switch (request.requestKind) {
        case "instance": return result.kind === "instance" && result.receipt.instanceId === request.request.instanceId && BigInt(result.receipt.instanceEpoch) === BigInt(request.request.previousInstanceEpoch ?? "0") + 1n;
        case "intent": return result.kind === "intent" && result.receipt.action === request.request.action && BigInt(result.receipt.intentVersion) === BigInt(request.request.expectedVersion) + 1n;
        case "activation": {
          const receipt = result.kind === "activation" ? result.receipt : result.kind === "intent" ? result.activation : null;
          if (result.kind === "intent" && result.activationOutcome === "not_committed") return original.phase === "activation" && result.receipt.action === "resume" && result.receipt.intentVersion === request.request.intentVersion;
          return receipt !== null && receipt.action === ("action" in request.request ? request.request.action : "resume")
            && receipt.instanceEpoch === request.request.instanceEpoch && receipt.intentVersion === request.request.intentVersion && receipt.localEpoch === request.request.localEpoch && receipt.scopeGeneration === request.request.scopeGeneration;
        }
      }
    };
    if (!matches(result)) throw new Error("Original lifecycle result does not match its frozen request.");
    const receipt = original.phase === "activation" && result.kind === "intent" ? result.activationOutcome === "not_committed" ? result : result.activation : result.receipt;
    if (receipt === null) throw new Error("Original lifecycle activation remains unresolved.");
    store.recordOperation({ operationId: original.operationId, phase: original.phase, status: result.kind === "not_committed" || result.kind === "intent" && original.phase === "activation" && result.activationOutcome === "not_committed" ? "rejected" : "confirmed", receipt: json(receipt) });
  };
  const reconcileOperations = async (): Promise<void> => {
    for (const original of store.listOperations()) await resolveOriginal(original);
  };
  const stop = async (): Promise<void> => {
    const initial = store.readState();
    if (initial.phase === "disabled" && initial.inventoryComplete && initial.stop === "confirmed" && initial.save === "durable") return;
    const deadline = Date.now() + 60_000;
    const results = control === undefined ? [] : closedOwner?.control === control ? closedOwner.results : await control.reconcile({ deadline });
    if (control !== undefined && results.every(result => result.stop === "confirmed" && result.save === "durable")) closedOwner = { control, results };
    if (results.some(result => result.stop !== "confirmed" || result.save !== "durable")) throw new Error("Original execution owners must join before constructing recovery owners.");
    await options.reconcileResources(deadline);
    const snapshot = store.snapshot();
    store.markStopped({ localEpoch: snapshot.state.localEpoch, inventoryRevision: snapshot.inventoryRevision, owners: json(results) as unknown as OwnerStopResult[] });
  };
  const reconcileReports = async (): Promise<void> => {
    const pending = store.listOutbox().filter(row => !["confirmed", "covered"].includes(row.uploadState));
    if (pending.length === 0) return;
    const authority = await readAuthority();
    for (const original of pending) {
      const observed = authority.observation, instance = authority.instance;
      if (instance !== null && (BigInt(instance.instanceEpoch) > BigInt(original.instanceEpoch)
        || instance.instanceEpoch === original.instanceEpoch && (BigInt(authority.intentVersion) > BigInt(original.intentVersion)
          || authority.intentVersion === original.intentVersion && observed !== null && BigInt(observed.reportSequence) > BigInt(original.reportSequence)))) {
        store.coverOutbox(original.id, { instanceEpoch: instance.instanceEpoch, intentVersion: authority.intentVersion, reportSequence: observed?.reportSequence ?? null, receivedAt: observed?.observation.receivedAt ?? authority.observedAt });
        continue;
      }
      const request = parseLifecycleObservationEnvelope(original.payload);
      if (observed !== null && observed.instanceEpoch === original.instanceEpoch && observed.intentVersion === original.intentVersion && observed.reportSequence === original.reportSequence) {
        const { receivedAt, freshUntil: _freshUntil, ...observation } = observed.observation;
        if (!isDeepStrictEqual(json({ ...observed, observation }), json(request))) throw new Error("Original report sequence has different saved content.");
        store.ackOutbox(original.id, "confirmed", { protocolVersion: 1, accepted: true, instanceEpoch: observed.instanceEpoch, intentVersion: observed.intentVersion, reportSequence: observed.reportSequence, receivedAt });
      } else {
        // Observation POST is idempotent at this exact sequence and payload. Its
        // original receipt never refreshes the server's observation freshness.
        const receipt = await api.report(request, signal);
        store.ackOutbox(original.id, "confirmed", json(receipt));
      }
    }
    store.compactHistory();
  };
  const report = async (): Promise<LifecycleObservationEnvelope> => {
    await reconcileReports();
    const snapshot = store.snapshot(128), state = snapshot.state, current = binding();
    const recovery = [...options.recovery?.() ?? []].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
    const previous = store.listOutbox().filter(row => row.instanceEpoch === current.instanceEpoch);
    const sequence = String(previous.reduce((max, row) => BigInt(row.reportSequence) > max ? BigInt(row.reportSequence) : max, 0n) + 1n);
    const identityValue = (identity: Record<string, LifecycleJson>, key: string): string | null => typeof identity[key] === "string" ? identity[key] as string : null;
    const envelope: LifecycleObservationEnvelope = {
      protocolVersion: 1, instanceId: current.instanceId, instanceEpoch: current.instanceEpoch, intentVersion: current.intentVersion,
      operationId: authorityOperationId, localEpoch: current.localEpoch, scopeGeneration: current.scopeGeneration, reportSequence: sequence,
      observation: {
        phase: state.phase, stop: state.stop, save: state.save, sync: state.sync, inventoryComplete: snapshot.inventoryComplete, detailsComplete: snapshot.detailsComplete && recovery.length <= 128,
        inventoryRevision: snapshot.inventoryRevision, inventoryDigest: snapshot.inventoryDigest,
        resourceCount: snapshot.counts.total, stoppedCount: snapshot.counts.stopped, pendingCount: snapshot.counts.pending, blockedCount: snapshot.counts.blocked,
        resources: snapshot.resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId)).map(resource => ({
          resourceId: resource.resourceId, ownerKind: resource.ownerKind,
          projectId: identityValue(resource.identity, "projectId"), taskId: identityValue(resource.identity, "taskId"), botId: identityValue(resource.identity, "botId"), executionId: identityValue(resource.identity, "executionId"), sessionId: identityValue(resource.identity, "sessionId"), executionGeneration: identityValue(resource.identity, "executionGeneration"),
          stage: terminal(resource.stage) ? "stopped" : resource.stage === "running" ? "running" : resource.stage === "reserved" ? "reserved" : "unknown",
          stop: terminal(resource.stage) ? "confirmed" : resource.stage === "unknown" ? "unknown" : "pending", save: resource.saveState, errorCode: resource.error === null ? null : "stop_unknown",
        })), recovery: recovery.slice(0, 128), errorCode: state.errorCode as LifecycleObservationEnvelope["observation"]["errorCode"],
      },
    };
    const id = randomUUID();
    store.appendOutbox({ id, instanceEpoch: current.instanceEpoch, intentVersion: current.intentVersion, reportSequence: sequence, payload: json(envelope) });
    let receipt;
    try { receipt = await api.report(envelope, signal); }
    catch (error) { store.ackOutbox(id, "unknown"); throw error; }
    store.ackOutbox(id, "confirmed", json(receipt));
    store.compactHistory();
    return envelope;
  };
  const finishPreparedActivation = async (activation: LifecycleActivation): Promise<void> => {
    const current = store.readState(), { operationId, action } = activation, phase = action === "resume" ? "activation" : "primary";
    if (current.phase !== "resuming" || !isDeepStrictEqual(current.activation, activation)) throw new Error("Original activation was superseded locally.");
    let original = store.readOperation(operationId, phase);
    if (original !== null && ["submitted", "unknown"].includes(original.status)) { await resolveOriginal(original); original = store.readOperation(operationId, phase); }
    let receipt;
    if (original === null || original.status === "prepared") {
      let request: LifecycleActivationRequest;
      if (original === null) {
        const observation = await report();
        request = { protocolVersion: 1, operationId, instanceId: activation.binding.instanceId, instanceEpoch: activation.binding.instanceEpoch, intentVersion: activation.binding.intentVersion, localEpoch: activation.binding.localEpoch,
          scopeGeneration: activation.binding.scopeGeneration, reportSequence: observation.reportSequence, ...(action === "resume" ? {} : { action }) };
      } else request = parseLifecycleActivationRequest(original.request);
      receipt = await send({ protocolVersion: 1, requestKind: "activation", request }, () => api.activate(request, signal), phase);
    } else if (original.status === "confirmed") receipt = parseLifecycleActivationReceipt(original.receipt);
    else { store.markBlocked("resume_interrupted"); throw new Error("Original activation did not commit; an explicit new resume is required."); }
    const authority = await readAuthority();
    if (authority.intentVersion !== receipt.intentVersion || authority.desired !== "enabled" || authority.admission !== "open" || authority.instance?.instanceId !== activation.binding.instanceId || authority.instance.instanceEpoch !== receipt.instanceEpoch) throw new Error("Worker authority changed after activation.");
    signal.throwIfAborted();
    store.commitActivation({ ...activation, receipt: json(receipt) });
    authorityOperationId = authority.operationId;
    control?.rebuild();
  };
  const activate = async (operationId: string, action: LifecycleActivation["action"]): Promise<void> => {
    const state = store.readState();
    const next = action === "bootstrap" ? state.scopeGeneration : String(BigInt(state.scopeGeneration) + 1n);
    const activation: LifecycleActivation = { binding: { ...binding(), scopeGeneration: next }, operationId, action };
    store.compactHistory({ beforeScopeGeneration: next });
    store.prepareActivation(activation);
    await finishPreparedActivation(activation);
  };
  const disableCloud = async (cloud: CloudResource): Promise<void> => {
    const state = store.readState();
    if (!state.localVeto || cloud.desired === "disabled") return;
    const local = store.listOperations().find(operation => operation.kind === "local_disable" && operation.localEpoch === state.localEpoch);
    if (local === undefined) throw new Error("Local veto has lost its original operation.");
    const acceptedResume = store.listOperations().find(operation => operation.phase === "primary" && operation.kind === "intent" && operation.status === "confirmed"
      && operation.operationId === cloud.operationId && operation.localEpoch === state.localEpoch && operation.receipt !== null && typeof operation.receipt === "object" && !Array.isArray(operation.receipt) && operation.receipt.action === "resume");
    if (acceptedResume !== undefined && store.readOperation(acceptedResume.operationId, "activation")?.status !== "rejected") return;
    const unsettled = store.listOperations().filter(operation => operation.localEpoch === state.localEpoch && operation.kind === "intent" && ["submitted", "unknown"].includes(operation.status));
    if (unsettled.length) { for (const operation of unsettled) await resolveOriginal(operation); return; }
    const attempts = store.listOperations().filter(operation => operation.kind === "intent" && operation.originOperationId === local.operationId);
    if (attempts.some(operation => operation.status === "rejected" && operation.receipt !== null && typeof operation.receipt === "object" && !Array.isArray(operation.receipt)
      && typeof operation.receipt.code === "string" && operation.receipt.code !== "version_conflict")) throw new Error("Original local disable was refused; a new operation cannot hide its refusal.");
    const request = { protocolVersion: 1 as const, operationId: randomUUID(), action: "disable" as const, expectedVersion: cloud.intentVersion, source: "local" as const, localEpoch: state.localEpoch, originOperationId: local.operationId };
    const receipt = await send({ protocolVersion: 1, requestKind: "intent", request }, () => api.intent(request, signal));
    store.observeAuthority(receipt);
    authorityOperationId = receipt.operationId;
    await stop();
  };
  const initialize = async (): Promise<void> => {
    if (initialized) return;
    if (initialization !== undefined && store.readState().phase === "resuming" && store.readState().activation !== null) {
      await finishPreparedActivation(store.readState().activation!); initialized = true; initialization = undefined; return;
    }
    const before = initialization?.before ?? store.readState();
    if (initialization === undefined) {
      if (before.phase === "resuming") store.markBlocked("resume_interrupted"); else store.markManagementFailure();
    }
    await options.reconcileResources(Date.now() + 60_000);
    await reconcileOperations();
    let registrationVerified = false;
    if (initialization !== undefined) {
      const original = store.readOperation(initialization.request.operationId);
      const refusal = original?.receipt;
      if (original?.status === "rejected" && refusal !== null && typeof refusal === "object" && !Array.isArray(refusal)
        && (refusal.status === 404 || refusal.code === "not_found") && options.ensureWorkerRegistered !== undefined) {
        // The rejected request remains immutable. Only renewed Worker registration
        // evidence permits a separate decision after its missing prerequisite.
        await options.ensureWorkerRegistered(true);
        registrationVerified = true;
        initialization = undefined;
      }
    }
    if (initialization === undefined) {
      if (!registrationVerified) await options.ensureWorkerRegistered?.();
      // A new management instance settles older unknown registrations before advancing its epoch.
      const recoveredInstances = store.listOperations().filter(operation => operation.kind === "instance" && operation.status === "confirmed").map(operation => operation.receipt).filter((value): value is { [key: string]: LifecycleJson } => value !== null && typeof value === "object" && !Array.isArray(value));
      const previousEpoch = recoveredInstances.reduce((max, receipt) => typeof receipt.instanceEpoch === "string" && (max === null || BigInt(receipt.instanceEpoch) > BigInt(max)) ? receipt.instanceEpoch : max, before.instanceEpoch);
      initialization = { before, request: { protocolVersion: 1, operationId: randomUUID(), instanceId: randomUUID(), previousInstanceEpoch: previousEpoch,
        capabilities: { disable: true, resume: true, inventory: 1, dispatchFence: 1 }, platform: options.platform } };
    }
    const pending = initialization;
    if (pending.receipt === undefined) {
      const original = store.readOperation(pending.request.operationId);
      if (original?.status === "confirmed") pending.receipt = parseLifecycleInstanceReceipt(original.receipt);
      else if (original === null || original.status === "prepared") pending.receipt = await send({ protocolVersion: 1, requestKind: "instance", request: pending.request }, () => api.register(pending.request, signal));
      else throw new Error("Original management registration remains unresolved or was refused.");
    }
    const receipt = pending.receipt;
    if (store.readState().instanceId !== receipt.instanceId || store.readState().instanceEpoch !== receipt.instanceEpoch) store.bindInstance(receipt);
    await stop();
    const cloud = await readAuthority();
    if (cloud.instance?.instanceId !== receipt.instanceId || cloud.instance.instanceEpoch !== receipt.instanceEpoch) throw new Error("Original Worker management instance was replaced.");
    store.observeAuthority(cloud);
    store.confirmManagementAuthority(binding());
    await stop();
    await disableCloud(cloud);
    if (normalReconnect(before) && receipt.reconnectAllowed && before.intentVersion === cloud.intentVersion && cloud.desired === "enabled"
      && !store.readState().localVeto && store.readState().errorCode === null) await activate(randomUUID(), "reconnect");
    else if (!before.bootstrapConsumed && !before.localVeto && before.instanceEpoch === null && before.activation === null && cloud.desired === "enabled" && cloud.operationId === null
      && !store.listOperations().some(operation => operation.kind === "activation")) await activate(randomUUID(), "bootstrap");
    else await report();
    initialized = true; initialization = undefined;
  };
  const tick = async (): Promise<void> => {
    if (!initialized) { await initialize(); return; }
    const local = store.readState();
    if (local.phase === "resuming" && local.activation !== null) { await finishPreparedActivation(local.activation); await report(); return; }
    // Local closure must stop work before any network request can consume its budget.
    if (local.admission === "closed" && local.phase !== "disabled" && local.phase !== "resuming") await stop();
    const cloud = await readAuthority();
    authorityOperationId = cloud.operationId;
    if (cloud.instance?.instanceId !== binding().instanceId || cloud.instance.instanceEpoch !== binding().instanceEpoch) throw new Error("Original Worker management instance was replaced.");
    store.confirmManagementAuthority(binding());
    const current = store.readState();
    if (current.admission === "closed" && cloud.admission === "open" && cloud.desired === "enabled" && cloud.intentVersion === current.intentVersion && normalReconnect(current)) {
      // Registration closes cloud admission and grants reconnect before a stopped report is sent.
      initialized = false;
      await initialize();
      return;
    }
    if (cloud.desired === "disabled" && (cloud.intentVersion !== current.intentVersion || current.admission !== "closed" || !current.inventoryComplete || current.stop !== "confirmed")
      || cloud.desired !== "disabled" && cloud.intentVersion !== current.intentVersion && cloud.operationId !== null) {
      store.observeAuthority(cloud);
      if (cloud.desired === "disabled") { store.closeAdmission({ operationId: cloud.operationId ?? randomUUID(), local: false }); await stop(); }
      else {
        // A remote resume is consumed only when it names this freshly stopped epoch.
        const original = await api.operation(cloud.operationId!, signal);
        if (original.kind !== "intent" || original.receipt.action !== "resume") throw new Error("Remote resume intent has no matching operation.");
        store.prepareOperation({ operationId: original.receipt.operationId, kind: "intent", request: null });
        store.recordOperation({ operationId: original.receipt.operationId, status: "confirmed", receipt: json(original.receipt) });
        await stop();
        await activate(original.receipt.operationId, "resume");
      }
    }
    await disableCloud(cloud);
    await report();
  };
  return {
    binding,
    initializeForControl: (): Promise<LifecycleBinding> => serialize(async () => {
      const state = store.readState();
      if (state.localVeto || state.desired === "disabled" || state.errorCode === "resume_interrupted") throw new Error("Worker control requires enabled lifecycle authority; explicit resume is required.");
      await initialize();
      const current = binding(); store.assertAdmission(current); return current;
    }),
    attach(controlValue: LifecycleExecutionControl): void { control = controlValue; },
    detach(): void { control = undefined; },
    start(): void {
      if (active) return; active = true;
      localWatch = (async () => {
        while (active && !signal.aborted) {
          try {
            const state = store.readState();
            if (state.admission === "closed" && control !== undefined && localStop === undefined && (lastLocalStop?.control !== control || lastLocalStop.epoch !== state.localEpoch)) {
              lastLocalStop = { control, epoch: state.localEpoch };
              const work = control.stop({ deadline: Date.now() + 60_000 }); localStop = work;
              void work.catch(error => { if (!signal.aborted) blocked(error, "stop_unknown"); }).finally(() => { if (localStop === work) localStop = undefined; });
            }
          } catch (error) { if (!signal.aborted) blocked(error, "persistence_failed"); try { await control?.stop({ deadline: Date.now() + 60_000 }); } catch (failure) { options.reportError(failure); } }
          try { await delay(1000, undefined, { signal }); } catch { break; }
        }
      })();
      polling = (async () => {
        while (active && !signal.aborted) {
          try { await serialize(tick); }
          catch (error) {
            if (!signal.aborted) {
              try { if (store.readState().phase === "resuming") options.reportError(error); else blocked(error); }
              catch (readError) { blocked(readError, "persistence_failed"); }
            }
            try { await control?.stop({ deadline: Date.now() + 60_000 }); } catch (stopError) { if (!signal.aborted) blocked(stopError, "stop_unknown"); }
          }
          try { await delay(1000, undefined, { signal }); } catch { break; }
        }
      })();
    },
    async waitForAdmission(): Promise<LifecycleBinding> {
      while (!signal.aborted) { const state = store.readState(); if (state.admission === "open") return binding(); await delay(100, undefined, { signal }); }
      signal.throwIfAborted(); throw new Error("Worker management stopped.");
    },
    reconcile: (): Promise<void> => serialize(async () => {
      const current = store.readState();
      if (current.admission !== "closed") throw new Error("Reconciliation requires an already closed Worker.");
      if (current.phase === "resuming" && current.activation !== null) { await finishPreparedActivation(current.activation); await report(); return; }
      await stop(); if (initialized) { await reconcileOperations(); await report(); }
    }),
    resume: (operationId: string): Promise<void> => serialize(async () => {
      if (store.readState().admission !== "closed") throw new Error("Resume requires an already disabled Worker.");
      if (!initialized) await initialize();
      await reconcileOperations(); await stop();
      const cloud = await readAuthority(); authorityOperationId = cloud.operationId;
      if (cloud.instance?.instanceId !== binding().instanceId || cloud.instance.instanceEpoch !== binding().instanceEpoch) throw new Error("Original Worker management instance was replaced.");
      store.observeAuthority(cloud); store.confirmManagementAuthority(binding()); await stop(); await report();
      const current = binding();
      const request = { protocolVersion: 1 as const, operationId, action: "resume" as const, expectedVersion: cloud.intentVersion, source: "local" as const, localEpoch: current.localEpoch, instanceEpoch: current.instanceEpoch };
      const receipt: LifecycleIntentReceipt = await send({ protocolVersion: 1, requestKind: "intent", request }, () => api.intent(request, signal));
      authorityOperationId = receipt.operationId; store.observeAuthority(receipt); await stop(); await activate(operationId, "resume");
    }),
    async close(): Promise<void> { active = false; await polling; await localWatch; await localStop; await tail; },
  };
};
export type LifecycleManager = ReturnType<typeof createLifecycleManager>;
