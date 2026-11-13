import { assertConfigurationAdmission } from "../configuration-admission.js";
import { ExecutionSourceConflictError } from "../execution-stop.js";
import type { CleanupTarget, StopObservation, TerminalCleanupContext } from "../execution-stop.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdirSync, lstatSync, readdirSync } from "node:fs";
import { ApiError } from "../../../api/client.js";
import { canonicalId } from "../../../api/parse.js";
import { readWorkerClaim, readTaskPaused } from "../../../api/task-properties.js";
import { createOperation, type Operation } from "../../../api/operation.js";
import type { Task } from "../../../api/types.js";
import { canonicalSessionJson, SessionV2Error, SESSION_V2_PROTOCOL } from "../../../session/v2/values.js";
import { isPreparedSessionV2StopProof } from "../../../session/v2/protocol.js";
import type { SessionV2Message, SessionV2Payloads, SessionV2NativeStopProof, TerminalBinding } from "../../../session/v2/types.js";
import { createWorkerHerdr, HerdrAgentActionError } from "../herdr.js";
import type { WorkerHerdrAdapter } from "../herdr.js";
import type { HerdrAgentObservation, HerdrExecutionContext, HerdrExecutionOwner, HerdrPromptReceipt, HerdrTaskBinding } from "./agents.js";
import { openHerdrLifecycleStore, herdrLedgerHash, isHerdrNeverStarted, parseHerdrExecutionTools } from "./lifecycle-store.js";
import { connectHerdrSession, publishHerdrLedger } from "./session-connection.js";
import type { HerdrExecutionTools, HerdrLifecycleRecord, HerdrLocalRun, HerdrRunPhase } from "./lifecycle-types.js";
import { ToolSelectionError, verifyToolLaunch } from "../../../platform/tool-executables.js";
import type { ExecutionConfiguration } from "../types.js";
import type { ActiveToolSelection } from "../tool-selection.js";
import { createMacProcessControl } from "./native-macos.js";
import { createHerdrSessionApi } from "./session-api.js";
import { resolveHerdrInstancePaths } from "./instance.js";

import { herdrInputEnvelope, openHerdrInputStore } from "./input-store.js";
import { createHerdrInputArbiter, type HerdrInputArbiter } from "./input-arbiter.js";
import type { HerdrInputTarget } from "./input-types.js";
import { inspectHerdrInput } from "./input-readiness.js";
import { HerdrInputWaitingError } from "./agents.js";
import { submitTerminalInput, type TerminalInput } from "./terminal-input.js";
import { createHerdrRpcClient } from "./rpc.js";
import { createHerdrInputSession } from "./input-session.js";
import { createHerdrRecordingRuntime } from "./recording-runtime.js";
import { readHerdrTerminalSnapshot } from "./recording-sampler.js";
import type { HerdrRecordingScreen } from "./recording-types.js";
import { createHerdrArchiveApi, ensureHerdrRecordingResponsibility, type HerdrArchiveApi } from "./archive-api.js";
import { hasConfirmedHerdrResourceDeletion } from "../resource-disposal.js";
import { createHerdrRecordingArchive } from "./recording-archive.js";
import { createHerdrRecordingResources } from "./recording-resources.js";
import { createNativeSelectionVerifier, type NativeSelectionVerifier } from "../native-selection.js";

type BaseOptions = Parameters<typeof createWorkerHerdr>[0];
type Identity = HerdrExecutionOwner;
const identity = (record: HerdrLifecycleRecord): Identity => ({ ...record.owner, claimId: record.claimId });
const current = (record: HerdrLifecycleRecord): HerdrLocalRun => {
  const run = record.runs.at(-1);
  if (!run) throw new Error("The original Herdr runtime has no durable identity.");
  return run;
};
const contextFor = (record: HerdrLifecycleRecord): HerdrExecutionContext => ({ ...identity(record), cwd: record.cwd, agent: record.owner.provider });
const bindingFor = (run: HerdrLocalRun): HerdrTaskBinding => ({ session: run.run.binding.sessionId, workspaceId: run.run.binding.workspaceId, paneId: String(run.run.binding.paneId), terminalId: run.run.binding.terminalId });
const key = (owner: Identity): string => `${owner.projectId}/${owner.taskId}/${owner.claimId}`;

export const herdrRunDirectory = (root: string, instanceId: string): string => {
  if (!path.isAbsolute(root) || canonicalId(instanceId) !== instanceId) throw new Error("Herdr instance directory requires an absolute root and canonical instance UUID.");
  return path.join(root, "r", Buffer.from(instanceId.replaceAll("-", ""), "hex").toString("base64url"));
};

export const assertHerdrRecovery = (run: { phase: HerdrRunPhase; nativeSessionId: string | null; initialAssignment: HerdrLifecycleRecord["initialAssignment"] }): void => {
  if (run.phase !== "stopped_confirmed") throw new Error("The original Herdr run has no confirmed stop; replacement startup is prohibited.");
  if (run.nativeSessionId === null) throw new Error("The original native session identity is unknown; recovery cannot create another conversation.");
  if (run.initialAssignment !== "transport_completed") throw new Error("The original initial input is unconfirmed; automatic recovery requires explicit resolution.");
};

/** Each run owns a daemon so stopping its PTY cannot affect another task. */
export const createDurableWorkerHerdr = (options: BaseOptions & {
  serverOrigin: string;
  serverToken: string;
  workerId: string;
  readTask: (projectId: string, taskId: string, signal: AbortSignal) => Promise<Task>;
  processControl?: ReturnType<typeof createMacProcessControl>;
  sessionApi?: ReturnType<typeof createHerdrSessionApi>;
  createAdapter?: typeof createWorkerHerdr;
  inspectInput?: typeof inspectHerdrInput;
  submitInput?: typeof submitTerminalInput;
  archiveApi?: HerdrArchiveApi;
  readRecording?: (record: HerdrLifecycleRecord, signal: AbortSignal) => Promise<HerdrRecordingScreen>;
  currentUserId?: (signal: AbortSignal) => Promise<string>;
  readExecutionConfiguration?: (context: HerdrExecutionContext) => ExecutionConfiguration | null;
}) : WorkerHerdrAdapter => {
  const selectionOwner = options.selectionVerifier ?? createNativeSelectionVerifier();
  // A newer queued probe invalidates an older cleanup result. The synchronous
  // resource views must retain ownership until that newer generation settles.
  let selectionEpoch = 0, settledSelectionEpoch = 0;
  const settleSelection = async (): Promise<void> => {
    const epoch = selectionEpoch;
    settledSelectionEpoch = -1;
    await selectionOwner.settle();
    if (selectionEpoch !== epoch) throw new Error("Native selection changed during cleanup; original resources must be retained.");
    settledSelectionEpoch = epoch;
  };
  const selectionVerifier: NativeSelectionVerifier = {
    verify: async (input, operation) => {
      const epoch = ++selectionEpoch;
      await selectionOwner.verify(input, operation);
      if (selectionEpoch === epoch) settledSelectionEpoch = epoch;
    },
    settle: settleSelection,
    close: () => selectionOwner.close(),
  };
  mkdirSync(options.paths.workerDirectory, { recursive: true, mode: 0o700 });
  const store = openHerdrLifecycleStore(path.join(options.paths.workerDirectory, "herdr-executions.sqlite"));
  const inheritedSessions = new Set(store.list().map(record => record.sessionId));
  const inputStore = openHerdrInputStore(path.join(options.paths.workerDirectory, "herdr-inputs.sqlite"));
  const arbiters = new Map<string, HerdrInputArbiter>();
  const nativeBatches = new Map<string, { written: boolean; width: number; height: number }>();
  const inputFailures = new Map<string, Error>();
  const promptGuards = new Map<string, (operation: Operation) => Promise<boolean>>();
  const bridgeRegistrations = new Set<string>();
  const disconnectedBeforeInput = new Set<string>();
  const native = options.processControl ?? createMacProcessControl();
  const apiFor = (operation: Operation, archiveState = false) => {
    if (options.sessionApi) return options.sessionApi;
    const http = createHerdrSessionApi(options.serverOrigin, options.serverToken, { timeoutMs: operation.limits.requestMs, archiveState });
    return { ...http, register: async (...args: Parameters<typeof http.register>) => {
      const request = args[0], owner = { ...request.payload.owner, claimId: request.claimId }, record = need(owner);
      if (current(record).phase !== "active" || record.segments.at(-1)?.endedAt !== null) return http.register(...args);
      bridgeRegistrations.add(record.sessionId);
      return inputSession.register(...args);
    } };
  };
  const createAdapter = options.createAdapter ?? createWorkerHerdr;
  const adapters = new Map<string, ReturnType<typeof createWorkerHerdr>>();
  const connected = new Set<string>();
  const attachedRuns = new Set<string>();
  const pendingAttachmentPublications = new Set<string>();
  const locks = new Map<string, Promise<void>>();
  const legacy = createAdapter({ ...options, selectionVerifier });
  const need = (owner: Identity): HerdrLifecycleRecord => {
    if (store.retired(owner)) throw new Error("The original never-started claim is retired; execution cannot resume.");
    const record = store.get(owner);
    if (!record || record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || record.owner.worktreeId !== owner.worktreeId) throw new Error("The original Herdr execution evidence is missing or belongs to another owner; resources are retained.");
    return record;
  };
  const update = (owner: Identity, change: (record: HerdrLifecycleRecord) => void): HerdrLifecycleRecord => store.update(need(owner), change);
  const serialize = async <T>(owner: Identity, action: () => Promise<T>): Promise<T> => {
    const name = key(owner), previous = locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate); locks.set(name, tail);
    await previous;
    try { return await action(); }
    finally { release(); if (locks.get(name) === tail) locks.delete(name); }
  };
  class ClaimAuthorizationError extends Error {}
  const verifyClaim = async (owner: Identity, operation: Operation): Promise<Task> => {
    const task = await options.readTask(owner.projectId, owner.taskId, operation.signal);
    const claim = readWorkerClaim(task.properties);
    if (task.projectId !== owner.projectId || task.id !== owner.taskId || task.status !== "in_progress" || !task.allowAgents || !claim || claim.state !== "active" || claim.claimId !== owner.claimId || claim.workerId !== options.workerId || claim.worktreeId !== owner.worktreeId || claim.agentControlMode !== "herdr") throw new ClaimAuthorizationError("The original active Herdr claim no longer authorizes native execution.");
    return task;
  };
  const verifyInputPurpose = async (owner: Identity, operation: Operation, purpose: "automatic" | "manual" | "resume"): Promise<void> => {
    const task = await verifyClaim(owner, operation);
    if (purpose !== "manual" && readTaskPaused(task.properties) === true) {
      if (purpose === "resume") throw new SessionV2Error("permission_denied");
      throw new HerdrInputWaitingError("task_paused", "The task is paused; automatic input is waiting.");
    }
  };
  const verifyAutomaticAdmission = async (owner: Identity, operation: Operation): Promise<void> => {
    try { await verifyInputPurpose(owner, operation, "automatic"); }
    catch (error) { if (error instanceof ClaimAuthorizationError) throw new SessionV2Error("permission_denied"); throw error; }
  };
  const adapter = (record: HerdrLifecycleRecord, directory = current(record).instanceDirectory) => {
    const source = record.preparation?.instanceDirectory === directory ? record.preparation : record.runs.find(run => run.instanceDirectory === directory);
    if (!source) throw new Error("The requested Herdr adapter has no original lifecycle owner.");
    const launches = source.launches, cacheKey = canonicalSessionJson([directory, launches ?? null]);
    let value = adapters.get(cacheKey);
    if (!value) {
      const owner = identity(record);
      value = createAdapter({ ...options, selectionVerifier, paths: { ...options.paths, herdrDirectory: directory, logsDirectory: path.join(directory, "logs") },
        ...(launches === undefined ? { herdrLaunch: undefined, toolLaunch: undefined, readExecutionConfiguration: () => null } : { herdrLaunch: launches.herdr,
          readExecutionConfiguration: () => ({ agent: record.owner.provider, agentControlMode: "herdr", model: null, args: [], recoveryLimit: 0,
            ...(launches.agent === null ? {} : { toolLaunch: launches.agent, toolObservation: launches.agentObservation! }), herdrLaunch: launches.herdr, herdrObservation: launches.herdrObservation }) }),
        retainOnStartupFailure: true, isolatedRun: true,
        onDaemonSpawn: async pid => {
          const daemon = await native.capture(pid, "daemon");
          update(owner, draft => {
            if (!draft.preparation || draft.preparation.instanceDirectory !== directory || draft.preparation.phase !== "launch_requested") throw new Error("The Herdr launch no longer owns its preparation intent.");
            draft.preparation.daemon = daemon;
          });
        },
      });
      adapters.set(cacheKey, value);
    }
    return value;
  };
  const frozenTools = async (record: HerdrLifecycleRecord, operation: Operation): Promise<HerdrExecutionTools> => {
    const previous = record.runs.at(-1);
    let launches = previous?.launches;
    if (previous !== undefined && launches === undefined) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
    if (launches === undefined) {
      const configuration = options.readExecutionConfiguration?.(contextFor(record));
      if (!configuration?.herdrLaunch || !configuration.herdrObservation || record.owner.provider !== "claude" && (!configuration.toolLaunch || !configuration.toolObservation)) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
      launches = parseHerdrExecutionTools({ agent: record.owner.provider === "claude" ? null : configuration.toolLaunch,
        agentObservation: record.owner.provider === "claude" ? null : configuration.toolObservation, herdr: configuration.herdrLaunch, herdrObservation: configuration.herdrObservation });
      if (configuration.agent !== record.owner.provider || launches.agent !== null && launches.agent.tool !== record.owner.provider) throw new Error("The frozen tools belong to another execution provider.");
    }
    await verifyToolLaunch(launches.herdr, operation);
    if (launches.agent !== null) await verifyToolLaunch(launches.agent, operation);
    return launches;
  };
  const envelope = (record: HerdrLifecycleRecord) => ({ protocol: SESSION_V2_PROTOCOL, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: record.sessionId, claimId: record.claimId,
    executionGeneration: current(record).run.executionGeneration, agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const });
  const connect = async (owner: Identity, operation: Operation, canAdmitNewExecution?: () => boolean): Promise<void> => {
    const record = need(owner);
    if (connected.has(record.sessionId) && record.registrationRequest === null) return;
    await connectHerdrSession(store, owner, apiFor(operation), operation.signal, { observe: true, control: true, archive: true }, canAdmitNewExecution);
    if (bridgeRegistrations.has(record.sessionId)) inputSession.activate(record.sessionId);
    connected.add(record.sessionId);
    void recording.republish(need(owner), operation.signal).catch(() => {});
  };
  const publish = async (owner: Identity, operation: Operation, canAdmitNewExecution?: () => boolean): Promise<void> => {
    const record = need(owner);
    if (current(record).phase !== "stopped_confirmed" || record.connectionEpoch === null) await connect(owner, operation, canAdmitNewExecution);
    await publishHerdrLedger(store, owner, apiFor(operation, current(record).phase === "stopped_confirmed"), operation.signal);
    // A sampler can persist its first screen before this segment is accepted.
    // Retry that complete frame after the ledger fence, even if it stays unchanged.
    void recording.republish(need(owner), operation.signal).catch(() => {});
  };
  const verifyRuntime = async (record: HerdrLifecycleRecord): Promise<void> => {
    const run = current(record);
    if (!run.daemon || run.processes.length < 2 || !run.processes.some(p => p.role === "shell") || !run.processes.some(p => p.role === "agent")) throw new Error("The original shell and native process evidence is incomplete.");
    for (const endpoint of [adapter(record).paths.apiEndpoint, adapter(record).paths.clientEndpoint]) {
      const peer = await native.peer(endpoint);
      if (JSON.stringify(peer.auditToken) !== JSON.stringify(run.daemon.auditToken) || peer.birthToken !== run.daemon.birthToken || peer.bootId !== run.daemon.bootId) throw new Error("The private Herdr daemon was replaced.");
    }
    for (const proof of [run.daemon, ...run.processes]) if (await native.observe(proof) !== "same") throw new Error("An original Herdr process is unavailable or changed; automatic input is prohibited.");
  };
  const inputTarget = (record: HerdrLifecycleRecord): HerdrInputTarget => {
    const run = current(record), segment = record.segments.at(-1);
    if (record.connectionEpoch === null || !segment || segment.executionGeneration !== run.run.executionGeneration || segment.endedAt !== null) throw new SessionV2Error("automation_suspended");
    return { sessionId: record.sessionId, claimId: record.claimId, executionGeneration: run.run.executionGeneration, connectionEpoch: record.connectionEpoch, segmentId: segment.segmentId, binding: { ...run.run.binding } };
  };
  const matchesInput = (record: HerdrLifecycleRecord, target: HerdrInputTarget): boolean => {
    const fresh = inputTarget(record);
    return canonicalSessionJson({ ...target, binding: { ...target.binding, nativeSessionId: fresh.binding.nativeSessionId } }) === canonicalSessionJson(fresh) && (target.binding.nativeSessionId === null || target.binding.nativeSessionId === fresh.binding.nativeSessionId);
  };
  const recoveryInitialAssignment = (record: HerdrLifecycleRecord): HerdrLifecycleRecord["initialAssignment"] => {
    const input = inputStore.get(record.sessionId);
    const matchesHistory = (target: HerdrInputTarget): boolean => {
      const run = record.runs.find(value => value.run.executionGeneration === target.executionGeneration)?.run;
      const segment = record.segments.find(value => value.segmentId === target.segmentId);
      if (target.sessionId !== record.sessionId || target.claimId !== record.claimId || record.connectionEpoch === null || BigInt(target.connectionEpoch) > BigInt(record.connectionEpoch) || !run || !segment || segment.executionGeneration !== target.executionGeneration || !run.segmentIds.includes(target.segmentId)) return false;
      const binding = { ...target.binding, nativeSessionId: run.binding.nativeSessionId };
      // Native identity may first become visible after this segment ended.
      return canonicalSessionJson(binding) === canonicalSessionJson(run.binding) && canonicalSessionJson(binding) === canonicalSessionJson({ ...segment.binding, nativeSessionId: run.binding.nativeSessionId }) && [target.binding.nativeSessionId, segment.binding.nativeSessionId].every(value => value === null || value === run.binding.nativeSessionId);
    };
    if (!input || input.unknownInput || input.target.executionGeneration !== current(record).run.executionGeneration || !matchesHistory(input.target)) return "unconfirmed";
    if (input.initialDisposition !== null) {
      const decision = input.operations.find(value => value.operationId === input.initialDisposition!.operationId);
      return decision?.source === "control" && decision.result.state === "transport_completed" && decision.controlAck !== null && matchesHistory(decision.target) ? "transport_completed" : "unconfirmed";
    }
    const receipt = input.operations.find(value => value.operationId === input.initialAttemptOperationId);
    if (record.initialPrompt === null || input.initialOutcome !== "transport_completed" || receipt?.source !== "initial" || receipt.result.state !== "transport_completed" || !matchesHistory(receipt.target) || BigInt(receipt.target.connectionEpoch) > BigInt(input.target.connectionEpoch)) return "unconfirmed";
    const digest = createHash("sha256").update(canonicalSessionJson({ operationId: input.initialOperationId, source: "initial", text: record.initialPrompt })).digest("hex");
    // The input receipt commits before the lifecycle projection. Keep an already
    // recovered unknown projection immutable and use its original durable receipt.
    return input.initialDigest === digest && receipt.digest === digest ? "transport_completed" : "unconfirmed";
  };
  const inspect = async (record: HerdrLifecycleRecord, purpose: "automatic" | "manual" | "resume" | "cleanup", operation: Operation) => {
    const local = adapter(record), context = contextFor(record), binding = bindingFor(current(record));
    return (options.inspectInput ?? inspectHerdrInput)({ binding, provider: record.owner.provider, purpose, operation,
      observe: () => local.tasks.observe(context, binding, operation), rpc: createHerdrRpcClient(local.paths.apiEndpoint) });
  };
  const getInput = (owner: Identity, allowRecovery = false): HerdrInputArbiter => {
    const record = need(owner);
    if (inputFailures.has(record.sessionId)) throw new Error("The original input journal could not persist suspension; input remains disabled.", { cause: inputFailures.get(record.sessionId) });
    let arbiter = arbiters.get(record.sessionId);
    if (arbiter && current(record).phase !== "active" && current(record).run.executionGeneration === arbiter.record().target.executionGeneration) return arbiter;
    const target = inputTarget(record);
    if (arbiter) { arbiter.bind(target, { allowRecovery }); return arbiter; }
    const hadJournal = inputStore.get(record.sessionId) !== null;
    const initialized = inputStore.bind(target, !hadJournal && inheritedSessions.has(record.sessionId) ? "unconfirmed" : record.initialAssignment, record.controlEpoch, { allowRecovery });
    if (!hadJournal && (record.automationBlocked || disconnectedBeforeInput.has(record.sessionId))) inputStore.update(initialized, draft => { draft.state = "suspended"; draft.unknownInput = true; });
    arbiter = createHerdrInputArbiter({ store: inputStore, sessionId: record.sessionId, propagateAutomaticFailures: true,
      verify: async (expected, purpose, signal) => {
        const operation = createOperation({ ...(signal ? { signal } : {}), limits: { totalMs: 10_000 } });
        try {
          const fresh = need(owner);
          if (inputFailures.has(fresh.sessionId)) throw new SessionV2Error("source_corrupt");
          if (!matchesInput(fresh, expected) || current(fresh).phase !== "active") throw new SessionV2Error("stale_fence");
          if (purpose === "automatic") {
            try { await verifyRuntime(fresh); } catch { throw new SessionV2Error("target_changed"); }
          }
          if (purpose === "cleanup") {
            const task = await options.readTask(owner.projectId, owner.taskId, operation.signal), claim = readWorkerClaim(task.properties);
            if (!claim || claim.claimId !== owner.claimId || claim.workerId !== options.workerId || claim.worktreeId !== owner.worktreeId || !task.allowAgents || readTaskPaused(task.properties) === true) throw new SessionV2Error("permission_denied");
          } else if (purpose === "automatic") await verifyAutomaticAdmission(owner, operation);
          else { try { await verifyInputPurpose(owner, operation, purpose); } catch { throw new SessionV2Error("permission_denied"); } }
          try { await verifyRuntime(fresh); } catch { throw new SessionV2Error("target_changed"); }
          // Lease requests use only read-only ownership/readiness checks; no native attach occurs here.
          const batch = nativeBatches.get(fresh.sessionId);
          // Paste intentionally makes the composer nonempty. Subsequent frames
          // retain authority and target checks without rejecting this batch's own text.
          const readiness = await inspect(fresh, batch?.written ? "manual" : purpose, operation);
          if (batch && (batch.width !== readiness.width || batch.height !== readiness.height)) throw new SessionV2Error("target_changed");
          const guard = purpose === "automatic" ? promptGuards.get(fresh.sessionId) : undefined;
          if (guard && !await guard(operation)) {
            try { await verifyRuntime(need(owner)); } catch { throw new SessionV2Error("target_changed"); }
            await verifyAutomaticAdmission(owner, operation);
            throw new SessionV2Error("stale_fence");
          }
          try { await verifyRuntime(need(owner)); } catch { throw new SessionV2Error("target_changed"); }
          const input = inputStore.get(fresh.sessionId);
          const manualWrite = input?.operations.some(value => value.source === "web" && value.result.state === "dispatching") === true;
          if (purpose !== "cleanup") {
            const remote = await (options.sessionApi ?? createHerdrSessionApi(options.serverOrigin, options.serverToken, { timeoutMs: 10_000 })).state({ owner: fresh.owner, sessionId: fresh.sessionId, claimId: fresh.claimId }, operation.signal);
            if (!remote.connected || remote.connectionEpoch !== fresh.connectionEpoch || remote.executionGeneration !== expected.executionGeneration) throw new SessionV2Error("stale_fence");
            if (manualWrite && (remote.control?.state !== "manual" || remote.control.controlEpoch !== input!.controlEpoch || canonicalSessionJson(remote.control.lease) !== canonicalSessionJson(input!.lease))) throw new SessionV2Error("lease_expired");
            if (purpose === "automatic" && remote.control !== null && (remote.control.state !== "automation" || remote.control.controlEpoch !== input?.controlEpoch)) {
              if (remote.control.state === "manual" || remote.control.state === "suspended") {
                try { await verifyRuntime(need(owner)); } catch { throw new SessionV2Error("target_changed"); }
                throw new HerdrInputWaitingError("control_suspended", "Automatic input is waiting for explicit control handoff.");
              }
              throw new SessionV2Error("stale_fence");
            }
          }
          if (inputFailures.has(fresh.sessionId)) throw new SessionV2Error("source_corrupt");
          if (purpose === "automatic") {
            try { await verifyRuntime(need(owner)); } catch { throw new SessionV2Error("target_changed"); }
            await verifyAutomaticAdmission(owner, operation);
          }
        } finally { operation.dispose(); }
      },
      execute: async (batch, write) => {
        const fresh = need(owner), operation = createOperation({ signal: write.signal, limits: { totalMs: 10_000 } });
        let progress: { written: boolean; width: number; height: number } | undefined;
        try {
          const readiness = await inspect(fresh, batch.source === "web" ? "manual" : batch.source === "cleanup" ? "cleanup" : "automatic", operation);
          progress = { written: false, width: readiness.width, height: readiness.height };
          nativeBatches.set(fresh.sessionId, progress);
          const payload = batch.payload;
          const inputs: TerminalInput[] = payload.kind === "keys" ? [{ kind: "keys", key: payload.key }] : [{ kind: "paste", text: payload.text }, ...(payload.kind === "prompt" ? [{ kind: "keys" as const, key: "Enter" as const }] : [])];
          // Every prompt is a single bounded paste followed by a separate Enter frame.
          // Oversize prompts fail before attach rather than submitting a truncated assignment.
          let transportError: Error | undefined;
          const outcome = await (options.submitInput ?? submitTerminalInput)({ endpoint: adapter(fresh).paths.clientEndpoint, terminalId: batch.target.binding.terminalId, ...readiness, inputs, signal: write.signal,
            beforeWrite: async () => { try { await write.beforeWrite(); } catch (error) { transportError = error instanceof Error ? error : new Error(String(error)); throw error; } }, onWrite: () => { write.markWritten(); progress!.written = true; } });
          if (outcome.status !== "transport_completed") throw transportError ?? new Error(outcome.reason);
        } finally { if (nativeBatches.get(fresh.sessionId) === progress) nativeBatches.delete(fresh.sessionId); operation.dispose(); }
      },
    });
    arbiters.set(record.sessionId, arbiter); return arbiter;
  };
  const inputSession = createHerdrInputSession({ serverToken: options.serverToken, getRecord: need,
    api: () => options.sessionApi ?? createHerdrSessionApi(options.serverOrigin, options.serverToken, { timeoutMs: 10_000 }),
    state: owner => getInput(owner).state(),
    control: (owner, message, signal) => getInput(owner).control(message, signal),
    input: (owner, message, signal) => getInput(owner).input(message, signal),
    onError: (owner, error) => { inputFailures.set(need(owner).sessionId, error); },
    suspend: owner => {
      const record = need(owner), input = arbiters.get(record.sessionId);
      if (input) input.suspend();
      else disconnectedBeforeInput.add(record.sessionId);
      // Revoking a browser lease suspends input while the relay remains live.
      // Only channel closure invalidates the confirmed connection registration.
      if (!inputSession.connected(record.sessionId)) connected.delete(record.sessionId);
    },
  });
  const recordingRoot = path.join(options.paths.workerDirectory, "herdr-recordings");
  const archiveApi = options.archiveApi ?? createHerdrArchiveApi(options.serverOrigin, options.serverToken);
  const archive = createHerdrRecordingArchive({ directory: path.join(options.paths.workerDirectory, "herdr-archives"), api: archiveApi });
  const recordingFailures = new Map<string, unknown>();
  const recording = createHerdrRecordingRuntime({ directory: recordingRoot,
    read: options.readRecording ?? (async (record, signal) => {
      const owner = identity(record), operation = createOperation({ signal, limits: { totalMs: 10_000 } });
      try {
        const local = adapter(record), rpc = createHerdrRpcClient(local.paths.apiEndpoint);
        return await readHerdrTerminalSnapshot({ binding: bindingFor(current(record)), operation, rpc,
          verify: async () => {
            const fresh = need(owner);
            if (current(fresh).phase !== "active" || current(fresh).run.executionGeneration !== current(record).run.executionGeneration) throw new SessionV2Error("target_changed");
            await verifyRuntime(fresh);
            const observed = await local.tasks.observe(contextFor(fresh), bindingFor(current(fresh)), operation);
            if (canonicalSessionJson(observed.binding) !== canonicalSessionJson(bindingFor(current(fresh)))) throw new SessionV2Error("target_changed");
          } });
      } finally { operation.dispose(); }
    }),
    publish: async (record, frame, recorded, signal) => {
      signal.throwIfAborted(); const fresh = need(identity(record)), segment = fresh.segments.at(-1);
      if (!segment || fresh.connectionEpoch === null || fresh.ledgerRequest !== null || fresh.publishedLedgerHash !== herdrLedgerHash(fresh)) throw new Error("The live segment has not been registered on this connection.");
      await inputSession.publishSnapshot(fresh.sessionId, { connectionEpoch: fresh.connectionEpoch, segmentId: segment.segmentId, segmentOrdinal: segment.segmentOrdinal, binding: { ...current(fresh).run.binding }, frame, recorded });
    },
  });
  const recordingFailed = (record: HerdrLifecycleRecord, error: unknown): void => {
    recordingFailures.set(record.sessionId, error);
    try { recording.source(record).fail(current(record).run.executionGeneration); } catch { /* Missing source is retained as a failure, never recreated. */ }
  };
  const prepareRecording = async (owner: Identity, operation: Operation): Promise<void> => {
    const record = need(owner); recording.prepare(record);
    const run = recording.source(record).status().runs.find(value => value.executionGeneration === current(record).run.executionGeneration)!;
    await ensureHerdrRecordingResponsibility(archiveApi, { owner: record.owner, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: run.executionGeneration }, { responsibilityId: run.responsibilityId, recordingEnabled: run.recordingEnabled }, operation.signal);
  };
  const startRecording = (owner: Identity): void => {
    const record = need(owner);
    try { recording.start(record); } catch (error) { recordingFailed(record, error); }
  };
  const stopRecording = async (owner: Identity, commitBoundary = true): Promise<void> => {
    const record = need(owner);
    let recovered: { segmentId: string; boundary: { endedAt: string; durationMs: string } }[];
    try {
      const boundary = await recording.stop(record);
      recovered = boundary ? [{ segmentId: record.segments.at(-1)!.segmentId, boundary }] : recording.recover(record);
    } catch (error) { recordingFailed(record, error); return; }
    if (commitBoundary && recovered.length) update(owner, draft => { for (const value of recovered) { const segment = draft.segments.find(s => s.segmentId === value.segmentId)!; segment.endedAt = value.boundary.endedAt; segment.durationMs = value.boundary.durationMs; } });
  };
  const recordingResources = createHerdrRecordingResources({ directory: recordingRoot, archive, list: () => store.list().filter(record => record.owner.serverOrigin === options.serverOrigin && !store.retired(identity(record))),
    get: need, source: record => { if (recordingFailures.has(record.sessionId)) throw recordingFailures.get(record.sessionId); return recording.source(record).snapshot(); },
    publishStopped: async (record, operation) => { await finishStop(identity(record), operation); }, readTask: options.readTask,
    currentUserId: options.currentUserId ?? (async () => { throw new Error("The original resource owner cannot be authenticated."); }),
  });
  const resources: typeof recordingResources = {
    resources: () => recordingResources.resources().map(resource => ({ ...resource, stopped: resource.stopped && selectionEpoch === settledSelectionEpoch })),
    advance: async (...args) => { await settleSelection(); return recordingResources.advance(...args); },
    retry: async (...args) => { await settleSelection(); return recordingResources.retry(...args); },
    dispose: async (...args) => { await settleSelection(); return recordingResources.dispose(...args); },
    cleaned: owner => {
      if (selectionEpoch !== settledSelectionEpoch) throw new Error("Native selection probe cleanup is unconfirmed; original resources must be retained.");
      recordingResources.cleaned(owner);
    },
  };
  // The same durable deletion decision retires both resource ownership and
  // pending stop publication. Disposal does not fabricate a remote ledger ACK.
  const retainedResources = () => resources.resources().filter(resource => !hasConfirmedHerdrResourceDeletion(resource));
  const enrich = (owner: Identity, observed: HerdrAgentObservation): void => {
    if (observed.nativeSession === null) return;
    const agent = need(owner).owner.provider;
    if (observed.nativeSession.source !== `herdr:${agent}` || observed.nativeSession.agent !== agent || canonicalId(observed.nativeSession.sessionId) !== observed.nativeSession.sessionId) throw new Error("The native Session was not confirmed by the original official Herdr integration.");
    update(owner, draft => {
      const run = current(draft), id = observed.nativeSession!.sessionId;
      if (run.run.binding.nativeSessionId !== null && run.run.binding.nativeSessionId !== id) throw new Error("The native conversation identity changed.");
      run.run.binding.nativeSessionId = id;
      for (const segment of draft.segments.filter(segment => segment.executionGeneration === run.run.executionGeneration)) segment.binding.nativeSessionId = id;
    });
    try { const record = need(owner); recording.source(record).enrichBinding(current(record).run.executionGeneration, current(record).run.binding); }
    catch (error) { recordingFailed(need(owner), error); }
    const input = arbiters.get(need(owner).sessionId);
    if (input && need(owner).segments.at(-1)?.endedAt === null) input.bind(inputTarget(need(owner)));
  };
  const publishObservedLedger = async (owner: Identity, operation: Operation): Promise<boolean> => {
    const record = need(owner);
    const disconnected = !connected.has(record.sessionId);
    if (current(record).phase === "active" && disconnected) {
      // Reconnect the original live target even when its identity and frame have
      // not changed. Registration cannot restore its suspended input authority.
      await verifyClaim(owner, operation);
      await verifyRuntime(record);
    }
    // Native identity can appear after the first input. A later unchanged
    // observation must also reconcile an earlier publication's unknown outcome.
    if (current(record).phase !== "active") return false;
    if (disconnected || record.registrationRequest !== null || record.ledgerRequest !== null || record.publishedLedgerHash !== herdrLedgerHash(record)) await publish(owner, operation);
    return true;
  };
  const publishObservedIdentity = async (owner: Identity, observed: HerdrAgentObservation, operation: Operation): Promise<boolean> => {
    enrich(owner, observed);
    return publishObservedLedger(owner, operation);
  };
  const confirmNativeSession = async (context: HerdrExecutionContext, binding: HerdrTaskBinding, operation: Operation): Promise<HerdrAgentObservation> => {
    for (;;) {
      operation.check();
      const record = need(context);
      if (current(record).phase !== "active" || canonicalSessionJson(bindingFor(current(record))) !== canonicalSessionJson(binding)) throw new Error("The original native Session confirmation lost its active runtime binding.");
      await verifyRuntime(record);
      const observed = await adapter(record).tasks.observe(context, binding, operation);
      if (canonicalSessionJson(observed.binding) !== canonicalSessionJson(binding)) throw new Error("The native Session observation belongs to another original runtime.");
      if (observed.nativeSession !== null) {
        if (observed.nativeSession.source !== `herdr:${context.agent}` || observed.nativeSession.agent !== context.agent || canonicalId(observed.nativeSession.sessionId) !== observed.nativeSession.sessionId) throw new Error("The native Session was not confirmed by the original official Herdr integration.");
        await verifyRuntime(need(context));
        await publishObservedIdentity(context, observed, operation);
        return observed;
      }
      await delay(Math.min(25, Math.max(1, Math.ceil(operation.remainingMs()))), undefined, { signal: operation.signal });
    }
  };
  const send = async (context: HerdrExecutionContext, prompt: string, operation: Operation, guard?: (operation: Operation) => Promise<boolean>, onSubmitted?: (receipt: HerdrPromptReceipt) => void, initialOnly = false, onTransportCompleted?: () => void) => {
    const record = need(context), run = current(record), arbiter = getInput(context);
    if (run.phase !== "active") throw new HerdrAgentActionError("The original input admission is not available.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    await verifyRuntime(record); await verifyInputPurpose(context, operation, "automatic");
    const control = arbiter.state().state;
    if (control === "manual" || control === "suspended" || arbiter.record().unknownInput) throw new HerdrInputWaitingError("control_suspended", "The original input admission is waiting for explicit control handoff.");
    if (control !== "automation") throw new HerdrAgentActionError("The original input admission is not available.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
    if (guard && !await guard(operation)) {
      await verifyRuntime(need(context));
      await verifyInputPurpose(context, operation, "automatic");
      return { submission: "skipped" as const, observation: await adapter(record).tasks.observe(context, bindingFor(run), operation) };
    }
    const currentInput = arbiter.record();
    if (initialOnly && (currentInput.initialOutcome !== "pending" || currentInput.initialDisposition !== null || currentInput.unknownInput)) return { submission: "skipped" as const, observation: await adapter(record).tasks.observe(context, bindingFor(run), operation) };
    const initial = currentInput.initialOutcome === "pending";
    if (!initial && run.run.binding.nativeSessionId === null && run.launches !== undefined) throw new HerdrInputWaitingError("native_session_pending", "The initial input is retained; automatic input is waiting for the original official native Session.");
    const body = initial ? record.initialPrompt : prompt;
    if (body === null) throw new Error("The original pending assignment body is missing.");
    const operationId = initial ? arbiter.record().initialOperationId : randomUUID();
    update(context, draft => { current(draft).admission = operationId; if (initial) draft.initialAssignment = "dispatching"; });
    if (guard) promptGuards.set(record.sessionId, guard);
    const result = await arbiter.submit({ operationId, source: initial ? "initial" : "continuation", text: body }, operation.signal).catch(error => {
      if (error instanceof HerdrAgentActionError && error.promptSubmission === "not-submitted") update(context, draft => { current(draft).admission = null; if (initial) draft.initialAssignment = "pending"; });
      throw error;
    }).finally(() => { promptGuards.delete(record.sessionId); });
    update(context, draft => {
      current(draft).admission = null;
      if (initial) draft.initialAssignment = result.state === "transport_completed" ? "transport_completed" : result.state === "rejected" ? "pending" : "unknown";
      else if (result.state === "unknown") draft.automationBlocked = true;
    });
    if (result.state === "rejected" && result.errorCode === "automation_suspended" && ["manual", "suspended"].includes(arbiter.state().state)) throw new HerdrInputWaitingError("control_suspended", "Automatic input is waiting for explicit control handoff.");
    if (result.state !== "transport_completed") throw new HerdrAgentActionError(`The original input admission returned ${result.state}: ${result.errorCode ?? "input_unknown"}.`, "agent.prompt", result.state === "rejected" ? "not-submitted" : "unknown", { promptSubmission: result.state === "rejected" ? "not-submitted" : "unknown" });
    try { onTransportCompleted?.(); } catch { /* Optional observation cannot alter input. */ }
    const observed = await adapter(need(context)).tasks.observe(context, bindingFor(run), operation); enrich(context, observed);
    const receipt: HerdrPromptReceipt = { submission: "submitted", observation: observed };
    // Delivery is already durable. A later ledger failure must not leave the
    // execution driver holding the accepted assignment as pending input.
    onSubmitted?.(receipt);
    await publishObservedLedger(context, operation);
    if (initial) return { ...receipt, observation: await confirmNativeSession(context, bindingFor(run), operation) };
    return receipt;
  };
  const finishStop = async (owner: Identity, operation: Operation): Promise<void> => {
    await settleSelection();
    await stopRecording(owner);
    // Each segment ends at its own run boundary, including after interrupted closure.
    update(owner, draft => {
      for (const segment of draft.segments) {
        if (segment.endedAt !== null) continue;
        const run = draft.runs.find(value => value.run.executionGeneration === segment.executionGeneration);
        if (run?.phase !== "stopped_confirmed" || run.run.stoppedAt === null) throw new Error("An open segment has no confirmed original run stop.");
        segment.endedAt = run.run.stoppedAt;
        segment.durationMs = String(Math.max(0, Date.parse(segment.endedAt) - Date.parse(segment.startedAt)));
      }
    });
    try { recording.closeRun(need(owner)); } catch (error) { recordingFailed(need(owner), error); }
    await publish(owner, operation);
  };
  const prepareShutdownRecovery = async (owner: Identity, prior: SessionV2Payloads["control_state"] | null, operation: Operation): Promise<void> => {
    const record = need(owner), run = current(record), input = inputStore.get(record.sessionId);
    if (!input || run.stopReason !== "shutdown" || !run.stopOperationId || input.state !== "closing" || !input.automationBeforeClosing || input.draftRisk || input.unknownInput || input.operations.some(value => ["queued", "dispatching"].includes(value.result.state)) || recoveryInitialAssignment(record) !== "transport_completed" || run.run.binding.nativeSessionId === null) return;
    const api = apiFor(operation), expected = { owner: record.owner, sessionId: record.sessionId, claimId: record.claimId };
    const existing = input.recoveries.find(value => value.prepare.executionGeneration === run.run.executionGeneration);
    if (existing) {
      // A persisted intent may have crossed the service boundary. Observation is
      // the only recovery operation; shutdown never repeats its POST.
      await api.readRecovery(expected, existing.prepare.payload.recoveryId, operation.signal); return;
    }
    if (!prior || prior.state !== "automation" || prior.initialAssignment !== "transport_completed" || prior.lease !== null || prior.connectionEpoch !== record.connectionEpoch || !options.sessionApi && !inputSession.connected(record.sessionId)) return;
    // Native identity can first appear after the initial input. Confirm that
    // enrichment on the original connection before requesting its exact binding.
    await publishHerdrLedger(store, owner, api, operation.signal);
    const publication = { ...herdrInputEnvelope(input.target), type: "control_state" as const, payload: prior };
    try { await api.publishControl(expected, publication, operation.signal); }
    catch { /* Read back the original publication before any further decision. */ }
    const remote = await api.state(expected, operation.signal);
    const control = remote.control;
    // Available actions are a capability-filtered presentation, not input authority.
    if (!remote.connected || remote.executionGeneration !== run.run.executionGeneration || remote.connectionEpoch !== record.connectionEpoch || canonicalSessionJson(remote.binding) !== canonicalSessionJson(run.run.binding) || !control || control.connectionEpoch !== prior.connectionEpoch || control.controlEpoch !== prior.controlEpoch || control.state !== prior.state || control.lease !== null || control.initialAssignment !== prior.initialAssignment || control.unavailableReason !== null) return;
    const prepare: Extract<SessionV2Message, { type: "automation_recovery_prepare" }> = { ...herdrInputEnvelope(input.target), type: "automation_recovery_prepare", payload: {
      recoveryId: randomUUID(), connectionEpoch: input.target.connectionEpoch, controlEpoch: prior.controlEpoch, closingControlEpoch: input.controlEpoch,
      stopOperationId: run.stopOperationId, binding: { ...run.run.binding }, initialAssignment: "transport_completed",
    } };
    inputStore.update(inputStore.get(record.sessionId)!, draft => { draft.recoveries.push({ prepare, request: null }); });
    try { await api.prepareRecovery(expected, prepare, operation.signal); }
    catch { await api.readRecovery(expected, prepare.payload.recoveryId, operation.signal); }
  };
  const resumeShutdownRecovery = async (owner: Identity, operation: Operation): Promise<void> => {
    const record = need(owner), run = current(record), input = inputStore.get(record.sessionId);
    if (!input || run.run.executionGeneration === "1") return;
    const priorRun = record.runs.at(-2), entry = input.recoveries.find(value => value.prepare.executionGeneration === priorRun?.run.executionGeneration);
    if (!entry || priorRun?.stopReason !== "shutdown" || priorRun.phase !== "stopped_confirmed" || priorRun.run.stopProof === null || isPreparedSessionV2StopProof(priorRun.run.stopProof) || priorRun.run.stopProof.recordId !== entry.prepare.payload.stopOperationId || priorRun.run.binding.nativeSessionId !== run.run.binding.nativeSessionId || run.run.binding.nativeSessionId !== entry.prepare.payload.binding.nativeSessionId || input.state !== "automation" || input.unknownInput || input.draftRisk || recoveryInitialAssignment(record) !== "transport_completed") {
      getInput(owner).suspend(); return;
    }
    const release = options.sessionApi ? () => {} : inputSession.holdRecovery(record.sessionId, entry.prepare);
    const api = apiFor(operation), expected = { owner: record.owner, sessionId: record.sessionId, claimId: record.claimId };
    try {
      await verifyClaim(owner, operation); await verifyRuntime(record); await inspect(record, "resume", operation);
      let receipt = await api.readRecovery(expected, entry.prepare.payload.recoveryId, operation.signal);
      const digest = createHash("sha256").update(canonicalSessionJson(entry.prepare)).digest("hex");
      if (receipt.payload.prepareDigest !== digest || receipt.payload.stopOperationId !== priorRun.stopOperationId || receipt.payload.nativeSessionId !== run.run.binding.nativeSessionId) throw new Error("The service recovery receipt differs from the original shutdown intent.");
      let request = entry.request;
      if (request === null) {
        if (receipt.payload.consumed !== null) throw new Error("The service consumed an unrecorded recovery request.");
        const remote = await api.state(expected, operation.signal), fresh = inputStore.get(record.sessionId)!;
        if (!remote.connected || remote.executionGeneration !== run.run.executionGeneration || remote.connectionEpoch !== record.connectionEpoch || !remote.control || !["suspended", "closing"].includes(remote.control.state) || remote.control.lease !== null) throw new Error("The original recovery connection is unavailable.");
        const controlEpoch = String((BigInt(fresh.controlEpoch) > BigInt(remote.control.controlEpoch) ? BigInt(fresh.controlEpoch) : BigInt(remote.control.controlEpoch)) + 1n);
        request = { ...herdrInputEnvelope(fresh.target), type: "automation_recovery", payload: { recoveryId: entry.prepare.payload.recoveryId, connectionEpoch: fresh.target.connectionEpoch, controlEpoch, previousGeneration: priorRun.run.executionGeneration, stopOperationId: priorRun.stopOperationId!, binding: { ...run.run.binding } } };
        const persisted = request;
        inputStore.update(fresh, draft => { draft.recoveries.find(value => value.prepare.payload.recoveryId === persisted.payload.recoveryId)!.request = persisted; });
        try { receipt = await api.recoverAutomation(expected, request, operation.signal); }
        catch { receipt = await api.readRecovery(expected, request.payload.recoveryId, operation.signal); }
      }
      const consumed = receipt.payload.consumed;
      if (!consumed || consumed.requestDigest !== createHash("sha256").update(canonicalSessionJson(request)).digest("hex") || consumed.executionGeneration !== run.run.executionGeneration || consumed.connectionEpoch !== record.connectionEpoch || consumed.controlEpoch !== request.payload.controlEpoch) throw new Error("The original automation recovery remains unconfirmed.");
      const remote = await api.state(expected, operation.signal), fresh = inputStore.get(record.sessionId)!;
      if (!remote.connected || remote.executionGeneration !== run.run.executionGeneration || remote.connectionEpoch !== record.connectionEpoch || remote.control?.state !== "automation" || remote.control.controlEpoch !== consumed.controlEpoch || remote.control.lease !== null || fresh.state !== "automation" || fresh.unknownInput || fresh.draftRisk) throw new Error("The service revoked the original automation recovery.");
      inputStore.update(fresh, draft => { draft.controlEpoch = consumed.controlEpoch; });
    } catch (error) { getInput(owner).suspend(); throw error; }
    finally { release(); }
  };
  const observeExecutionStop = async (target: CleanupTarget, operation: Operation): Promise<StopObservation> => {
    try {
      operation.check();
      if (target.worktreeId === undefined) throw new Error("The original Herdr worktree identity is missing.");
      const record = store.get(target);
      if (record === null) throw new Error("The original Herdr lifecycle is missing.");
      if (record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || record.owner.worktreeId !== target.worktreeId) throw new ExecutionSourceConflictError("The original Herdr lifecycle belongs to another execution owner.");
      const owner = identity(record);
      if (record.preparation !== null) throw new ExecutionSourceConflictError("A new Herdr preparation changes the execution source.");
      if (isHerdrNeverStarted(record)) return { kind: "not-started", owner, observedAt: Date.now() };
      if (record.runs.length === 0) throw new Error("The original Herdr run provenance is missing.");
      const run = current(record);
      const execution = { owner, backend: "herdr-native" as const, runKey: JSON.stringify([record.sessionId, run.run.executionGeneration]) };
      if (run.phase === "stopped_confirmed" && run.run.stopProof !== null) return { kind: "stopped", execution, observedAt: Date.now() };
      if (run.phase === "active" || run.phase === "prepared") return { kind: "running", execution, observedAt: Date.now() };
      throw new Error(`Herdr native stop remains unconfirmed (${run.phase}).`);
    } catch (error) {
      operation.check();
      return { kind: "unknown", target, error, observedAt: Date.now() };
    }
  };
  const stop = async (owner: Identity, reason: "shutdown" | "terminal", operation: Operation, scope?: TerminalCleanupContext): Promise<void> => {
    const before = need(owner);
    let input = arbiters.get(before.sessionId);
    let inputJournalError: unknown;
    let priorControl: SessionV2Payloads["control_state"] | null = null;
    let releaseShutdown = () => {};
    try {
      if (!input && before.runs.at(-1)?.phase === "active" && before.segments.at(-1)?.endedAt === null) input = getInput(owner);
      priorControl = input?.state() ?? null;
      input?.beginClosing();
      if (!options.sessionApi && inputSession.connected(before.sessionId)) releaseShutdown = inputSession.holdShutdown(before.sessionId);
    } catch (error) { inputJournalError = error; }
    await stopRecording(owner, false);
    const closeInput = () => {
      try { inputSession.close(before.sessionId); } catch (error) { inputJournalError ??= error; }
      finally { releaseShutdown(); }
      bridgeRegistrations.delete(before.sessionId);
    };
    try { await serialize(owner, async () => {
    // Probe cleanup gates resource release, but cannot delay or suppress an
    // independent attempt to stop this claim's original native processes.
    const results = await Promise.allSettled([settleSelection(), (async () => {
    let record = need(owner);
    if (record.runs.length === 0 && record.preparation === null) {
      if (reason === "terminal" && scope !== undefined) {
        const observation = await observeExecutionStop(owner, operation);
        if (observation.kind === "not-started") scope.onExecutionStopped({ attempt: scope.attempt, observation });
      }
      return false;
    }
    let run = current(record);
    if (run.phase !== "stopped_confirmed") {
      if (run.stopOperationId === null && run.daemon !== null && await native.observe(run.daemon) !== "same" && await native.bootIdentity() === run.daemon.bootId) {
        update(owner, draft => { current(draft).phase = "stop_unknown"; current(draft).error = "The original daemon disappeared without a durable stop intent."; });
        throw new Error("Herdr stop_unknown: absence without a durable stop intent cannot prove controlled resource shutdown.");
      }
      // A recovered close request already owns the stop intent and control fence.
      // Preserve that boundary while rechecking its original process identities.
      if (run.phase !== "close_requested") try { record = update(owner, draft => { const r = current(draft); r.phase = "stop_intent"; r.stopReason ??= reason; r.stopOperationId ??= randomUUID(); r.admission = null; draft.controlEpoch = String(BigInt(draft.controlEpoch) + 1n); if (draft.initialAssignment === "dispatching") draft.initialAssignment = "unknown"; }); }
      catch (journalError) {
        // A failed journal cannot authorize a durable stop conclusion, even if emergency signaling succeeds.
        if (run.daemon !== null) await native.stopExclusiveRun({ daemon: run.daemon, processes: run.processes }, operation);
        throw new Error("Herdr stop journal could not commit; emergency stop remains unconfirmed and resources must be retained.", { cause: journalError });
      }
      run = current(record);
      if (!inputJournalError) {
        let recovery: Operation | undefined;
        try {
          // Recovery permission is optional for stopping. Bound the whole HTTP
          // exchange and reserve the parent's remaining time for original processes.
          const totalMs = Math.max(1, Math.min(10_000, Math.floor(operation.remainingMs() / 2)));
          recovery = createOperation({ signal: operation.signal, limits: { totalMs, requestMs: totalMs } });
          await prepareShutdownRecovery(owner, priorControl, recovery);
        }
        catch { /* Missing recovery permission cannot prevent original native stopping. */ }
        finally { recovery?.dispose(); }
      }
      closeInput();
      if (run.daemon === null) { update(owner, draft => { current(draft).phase = "stop_unknown"; current(draft).error = "Original daemon identity is missing."; }); throw new Error("Herdr stop_unknown: original daemon identity is missing."); }
      try { update(owner, draft => { current(draft).phase = "close_requested"; }); }
      catch (journalError) {
        await native.stopExclusiveRun({ daemon: run.daemon, processes: run.processes }, operation);
        throw new Error("Herdr close journal could not commit; emergency stop remains unconfirmed.", { cause: journalError });
      }
      const outcome = await native.stopExclusiveRun({ daemon: run.daemon, processes: run.processes, onDiscovered: async proof => { update(owner, draft => { current(draft).processes.push(proof); }); } }, operation);
      // Stop discovery may append original descendants; commit only the current durable evidence.
      run = current(need(owner));
      const preparedStop = run.nativeLaunch === "not_submitted" && run.processes.length === 1 && run.processes[0]!.role === "shell" && run.run.segmentIds.length === 0;
      const nativeStop = run.nativeLaunch === "observed" && run.processes.some(p => p.role === "shell") && run.processes.some(p => p.role === "agent");
      if (outcome.state !== "stopped_confirmed" || !preparedStop && !nativeStop) {
        update(owner, draft => { current(draft).phase = "stop_unknown"; current(draft).error = outcome.reason ?? "The original shell/native resource evidence is incomplete."; });
        throw new Error(`Herdr stop_unknown: ${outcome.reason ?? "original resource proof is incomplete"}`);
      }
      const stoppedAt = new Date().toISOString();
      record = update(owner, draft => { const r = current(draft); r.phase = "stopped_confirmed"; r.error = null; r.run.stoppedAt = stoppedAt;
        const proof: SessionV2NativeStopProof = { recordId: r.stopOperationId!, executionGeneration: r.run.executionGeneration, binding: { ...r.run.binding }, bootId: r.daemon!.bootId, stoppedAt,
          method: outcome.method ?? "instances_exited", terminalStopped: true, processes: r.processes.map(p => ({ role: p.role === "shell" ? "shell" : "agent", pid: p.pid, birthToken: p.birthToken, bootId: p.bootId })) };
        const shell = r.processes[0]!, daemon = r.daemon!;
        r.run.stopProof = preparedStop ? { ...proof, nativeLaunch: "not_submitted", daemon: { pid: daemon.pid, birthToken: daemon.birthToken, bootId: daemon.bootId }, processes: [{ role: "shell", pid: shell.pid, birthToken: shell.birthToken, bootId: shell.bootId }] } : proof;
      });
    }
    if (reason === "terminal" && scope !== undefined) {
      const observation = await observeExecutionStop(owner, operation);
      if (observation.kind !== "stopped" && observation.kind !== "not-started") throw new Error("The original Herdr execution stop cannot be confirmed.");
      scope.onExecutionStopped({ attempt: scope.attempt, observation });
    }
    return true;
    })()]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Herdr native stopping and probe cleanup both failed.");
    if (results[1].status !== "fulfilled" || !results[1].value) return;
    // Segment closure is a separate recoverable boundary after the stop proof commits.
    await finishStop(owner, operation);
    if (reason === "terminal" && input && !inputJournalError) input.close();
    }); } finally { closeInput(); }
    if (inputJournalError) throw new Error("The input closing journal could not commit; native stopping was attempted but input evidence remains unavailable.", { cause: inputJournalError });
  };
  const attachRun = async (owner: Identity, operation: Operation): Promise<void> => {
    const record = need(owner), run = current(record), runKey = `${record.sessionId}/${run.run.executionGeneration}`;
    if (run.phase !== "active" || attachedRuns.has(runKey)) return;
    await verifyRuntime(record);
    if (!recording.canAllocate(record)) {
      await recording.exhaust(record);
      attachedRuns.add(runKey);
      pendingAttachmentPublications.add(runKey);
      await publish(owner, operation);
      return;
    }
    await stopRecording(owner);
    update(owner, draft => {
      const r = current(draft), previous = draft.segments.at(-1), segmentId = randomUUID();
      // A missing recording journal cannot extend an old frame across downtime.
      for (const segment of draft.segments) if (segment.endedAt === null) { segment.endedAt = segment.startedAt; segment.durationMs = "0"; }
      r.run.segmentIds.push(segmentId);
      draft.segments.push({ segmentId, segmentOrdinal: String(draft.segments.length + 1), executionGeneration: r.run.executionGeneration, binding: { ...r.run.binding }, startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
        gap: previous ? { kind: "boundary", reason: "restart", from: { executionGeneration: previous.executionGeneration, segmentId: previous.segmentId }, to: { executionGeneration: r.run.executionGeneration, segmentId } } : null });
    });
    startRecording(owner);
    attachedRuns.add(runKey);
    pendingAttachmentPublications.add(runKey);
    await publish(owner, operation);
  };
  for (const record of store.list()) { if (store.retired(identity(record))) continue; store.recover(record); if (inputStore.get(record.sessionId)) inputStore.recover(record.sessionId); }
  const tasks: ReturnType<typeof createWorkerHerdr>["tasks"] = {
    ...legacy.tasks,
    pendingStops: () => {
      const deleted = new Set(resources.resources().filter(hasConfirmedHerdrResourceDeletion).map(resource => key(resource.owner)));
      return store.list().filter(record => !deleted.has(key(identity(record))) && record.runs.length > 0
        && (["stop_intent", "close_requested", "stop_unknown"].includes(current(record).phase) || current(record).phase === "stopped_confirmed"
          && (record.segments.some(segment => segment.endedAt === null) || record.publishedLedgerHash !== herdrLedgerHash(record))))
        .map(record => ({ context: contextFor(record), binding: bindingFor(current(record)) }));
    },
    listResources: async operation => {
      const result = [];
      for (const record of store.list()) {
        if (record.owner.serverOrigin !== options.serverOrigin || record.runs.length === 0 || current(record).phase === "stopped_confirmed") continue;
        const run = current(record);
        try { result.push(...await adapter(record).tasks.listResources(operation)); }
        catch { if (run.phase === "active") update(identity(record), draft => { current(draft).phase = "stop_unknown"; current(draft).error = "The original private daemon could not be observed."; }); }
      }
      return result;
    },
    prepareWorkspace: (context, title, operation, input) => serialize(context, async () => {
      await verifyClaim(context, operation);
      let record = need(context);
      if (record.runs.length === 0) {
        const state = await apiFor(operation).current({ owner: record.owner, claimId: record.claimId }, operation.signal);
        if (state.status !== "not_registered") throw new Error("An existing Session has no matching local runtime; replacement startup is prohibited.");
      }
      if (record.runs.length > 0 && (current(record).phase === "active" || current(record).phase === "prepared")) {
        const run = current(record);
        if (run.daemon === null || await native.observe(run.daemon) !== "same" || await native.observe(run.processes[0]!) !== "same") throw new Error("The original prepared runtime changed.");
        return bindingFor(run);
      }
      if (record.runs.length > 0 && current(record).phase === "stopped_confirmed") {
        await finishStop(context, operation);
        record = need(context);
        if (isPreparedSessionV2StopProof(current(record).run.stopProof!)) throw new Error("A stopped prepared runtime cannot grant native recovery or a replacement generation.");
      }
      if (record.runs.length > 0) await connect(context, operation);
      if (record.runs.length > 0 && (!inputStore.get(record.sessionId) || inputStore.get(record.sessionId)!.unknownInput)) throw new Error("The original input journal is missing or unknown; automatic runtime recovery requires explicit resolution.");
      if (record.runs.length > 0) assertHerdrRecovery({ phase: current(record).phase, nativeSessionId: current(record).run.binding.nativeSessionId, initialAssignment: recoveryInitialAssignment(record) });
      if (record.preparation !== null) throw new Error("A previous Herdr preparation is unconfirmed; no replacement daemon may start.");
      if (!recording.canPrepareRun(record)) throw new Error("The retained recording budget cannot register another native run.");
      const launches = await frozenTools(record, operation);
      if (record.runs.length === 0) assertConfigurationAdmission(input?.canAdmitNewExecution);
      const instanceId = randomUUID(), instanceDirectory = herdrRunDirectory(options.paths.herdrDirectory, instanceId);
      // Validate the native socket budget before persisting a preparation that could launch.
      resolveHerdrInstancePaths({ herdrDirectory: instanceDirectory, logsDirectory: path.join(instanceDirectory, "logs") });
      record = update(context, draft => { draft.preparation = { instanceId, instanceDirectory, phase: "prepared", daemon: null, launches }; });
      record = update(context, draft => { draft.preparation!.phase = "launch_requested"; });
      const local = adapter(record, instanceDirectory);
      const ready = await local.ensureInstance(operation);
      const peer = await native.peer(local.paths.apiEndpoint);
      record = need(context);
      if (!record.preparation?.daemon || JSON.stringify(record.preparation.daemon.auditToken) !== JSON.stringify(peer.auditToken)) throw new Error("The prepared Herdr endpoint does not belong to its original daemon.");
      record = update(context, draft => { draft.preparation!.instanceObservation = { version: ready.version, protocol: ready.protocol, checkedAt: new Date().toISOString() }; });
      const startup = local.createShellStartup();
      const binding = await local.tasks.prepareWorkspace(context, title, operation, startup === undefined ? undefined : { shellNonce: startup.nonce });
      const processInfo = await local.tasks.processInfo(context, binding, operation);
      const shell = await native.capture(processInfo.shellPid, "shell", startup === undefined ? undefined : { executable: startup.executable, operation, ready: () => startup.isReady(processInfo.shellPid) });
      const generation = String(record.runs.length + 1), startedAt = new Date().toISOString();
      const terminal: TerminalBinding = { instanceId, sessionId: binding.session, workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.terminalId, nativeSessionId: record.runs.at(-1)?.run.binding.nativeSessionId ?? null };
      record = update(context, draft => { draft.runs.push({ run: { executionGeneration: generation, owner: draft.owner, binding: terminal, startedAt, stoppedAt: null, stopProof: null, segmentIds: [] }, phase: "prepared", nativeLaunch: "not_submitted", instanceDirectory, launches: draft.preparation!.launches!, instanceObservation: draft.preparation!.instanceObservation!, daemon: draft.preparation!.daemon, processes: [shell], stopOperationId: null, stopReason: null, error: null, admission: null }); draft.preparation = null; });
      recording.prepare(need(context));
      await publish(context, operation, input?.canAdmitNewExecution);
      await prepareRecording(context, operation);
      return binding;
    }),
    start: (context, binding, input, operation) => serialize(context, async () => {
      let record = need(context), run = current(record);
      if (run.phase !== "prepared" || run.nativeLaunch !== "not_submitted" || JSON.stringify(bindingFor(run)) !== JSON.stringify(binding)) throw new Error("Native launch requires the original prepared Herdr run.");
      const originallySubmitted = record.runs.some(value => value.nativeLaunch !== "not_submitted");
      const canAdmitNewExecution = () => originallySubmitted || (input.canAdmitNewExecution?.() ?? true);
      if (run.launches === undefined) throw new ToolSelectionError("herdr", "herdr", "launch", "legacy_tool_identity_missing");
      const beforeStart = async (active: Operation): Promise<void> => {
        const fresh = need(context), target = current(fresh), shell = run.processes.find(proof => proof.role === "shell");
        if (target.run.executionGeneration !== run.run.executionGeneration || !["prepared", "launch_requested"].includes(target.phase)) throw new Error("The original native launch no longer owns its prepared run.");
        await verifyClaim(context, active);
        if (run.daemon === null || shell === undefined || await native.observe(run.daemon) !== "same" || await native.observe(shell) !== "same") throw new Error("The original prepared runtime changed before native launch.");
        const peer = await native.peer(adapter(fresh).paths.apiEndpoint);
        if (JSON.stringify(peer.auditToken) !== JSON.stringify(run.daemon.auditToken) || peer.bootId !== run.daemon.bootId || peer.birthToken !== run.daemon.birthToken) throw new Error("The original daemon endpoint was replaced before native launch.");
        if (run.launches!.agent !== null) await verifyToolLaunch(run.launches!.agent, active);
        active.check();
      };
      await beforeStart(operation);
      await publish(context, operation, canAdmitNewExecution);
      await prepareRecording(context, operation);
      const recovery = record.initialAssignment !== "pending";
      const existing = recovery ? null : record.initialPrompt;
      if (existing === null) await input.preparePromptSource?.(operation);
      const prompt = existing ?? input.preparePrompt?.(recovery) ?? (recovery ? "Continue the original assigned task under its existing authorization." : input.prompt);
      input.onPromptPrepared?.(prompt, recovery);
      assertConfigurationAdmission(canAdmitNewExecution);
      record = update(context, draft => { if (draft.initialAssignment === "pending") draft.initialPrompt = prompt; });
      const manager = adapter(record).tasks;
      const observed = await manager.launch(context, binding, { configuration: { ...input.configuration, ...(run.launches.agent === null ? {} : { toolLaunch: run.launches.agent }) }, beforeStart, canAdmitNewExecution,
        onSubmitting: () => { update(context, draft => { current(draft).phase = "launch_requested"; current(draft).nativeLaunch = "requested"; }); },
        onRejected: () => { store.confirmNativeLaunchRejected(need(context), { method: "agent.start", code: "agent_pane_busy", executionGeneration: run.run.executionGeneration, binding: run.run.binding }); },
        ...(run.run.binding.nativeSessionId === null ? {} : { resumeSessionId: run.run.binding.nativeSessionId }) }, operation);
      const info = await manager.processInfo(context, binding, operation);
      const shell = run.processes.find(p => p.role === "shell");
      if (shell === undefined || info.shellPid !== shell.pid || await native.observe(shell) !== "same") throw new Error("The original shell changed while launching the native agent.");
      if (run.launches.agent !== null) {
        const receipt = await manager.launchReceipt?.(context, binding, operation);
        if (!receipt || receipt.selectionKey !== run.launches.agent.selectionKey || receipt.helperPid === receipt.childPid) throw new Error("The original native launch receipt is missing or changed; input remains closed.");
        const helper = await native.capture(receipt.helperPid, "agent");
        if (helper.ppid !== shell.pid || helper.sid !== shell.sid || helper.bootId !== shell.bootId || await native.observe(shell) !== "same" || await native.observe(helper) !== "same") throw new Error("The original helper process chain cannot be confirmed; input remains closed.");
        // Register the direct shell child before following loaders or descendants.
        // Stop recovery may extend only an already durable native-parent chain.
        update(context, draft => { current(draft).processes.push(helper); });
        const child = await native.capture(receipt.childPid, "agent");
        if (child.ppid !== helper.pid || child.pgid !== helper.pgid || child.sid !== shell.sid || child.bootId !== helper.bootId || await native.observe(helper) !== "same" || await native.observe(child) !== "same") throw new Error("The original helper child identity cannot be confirmed; input remains closed.");
        update(context, draft => { current(draft).processes.push(child); });
        const pending = await Promise.all(info.foregroundPids.filter(pid => ![shell.pid, helper.pid, child.pid].includes(pid)).map(pid => native.capture(pid, "agent")));
        while (pending.length > 0) {
          const known = current(need(context)).processes;
          const index = pending.findIndex(proof => known.some(parent => parent.role === "agent" && parent.pid === proof.ppid && parent.bootId === proof.bootId) && proof.pgid === helper.pgid && proof.sid === shell.sid);
          if (index < 0) throw new Error("The original native foreground process has no continuous helper chain; input remains closed.");
          const proof = pending.splice(index, 1)[0]!, parent = known.find(value => value.pid === proof.ppid)!;
          if (await native.observe(parent) !== "same" || await native.observe(proof) !== "same") throw new Error("The original native loader identity changed before registration.");
          update(context, draft => { current(draft).processes.push(proof); });
        }
      } else {
        const agents = await Promise.all(info.foregroundPids.filter(pid => pid !== info.shellPid).map(pid => native.capture(pid, "agent")));
        if (agents.length === 0) throw new Error("The original native agent has no identifiable foreground process; input remains closed.");
        update(context, draft => { current(draft).processes.push(...agents); });
      }
      update(context, draft => { current(draft).phase = "active"; current(draft).nativeLaunch = "observed"; });
      try { input.onAgentStarted?.(); } catch { /* Optional observation cannot alter launch. */ }
      try { input.onAgentInitializing?.(); } catch { /* Optional observation cannot alter launch. */ }
      enrich(context, observed);
      update(context, draft => {
        const r = current(draft), segmentId = randomUUID(), previous = draft.segments.at(-1);
        r.run.segmentIds.push(segmentId);
        draft.segments.push({ segmentId, segmentOrdinal: String(draft.segments.length + 1), executionGeneration: r.run.executionGeneration, binding: { ...r.run.binding }, startedAt: new Date().toISOString(), endedAt: null, durationMs: null,
          gap: previous ? { kind: "boundary", reason: "restart", from: { executionGeneration: previous.executionGeneration, segmentId: previous.segmentId }, to: { executionGeneration: r.run.executionGeneration, segmentId } } : null });
      });
      startRecording(context);
      // Preparation uses HTTP registration. Start the input channel only after a
      // real active segment exists, so slow native launch cannot time out its channel.
      await publish(context, operation);
      if (!options.sessionApi) { connected.delete(record.sessionId); await connect(context, operation); }
      getInput(context, true);
      await resumeShutdownRecovery(context, operation);
      if (!options.sessionApi) await inputSession.poll(record.sessionId);
      attachedRuns.add(`${record.sessionId}/${run.run.executionGeneration}`);
      try { input.onAgentInitialized?.(); } catch { /* Optional observation cannot alter launch. */ }
      if (observed.status === "blocked") throw new HerdrInputWaitingError("native_blocked", "The native agent requires operator action before input.");
      const inputState = getInput(context).state().state;
      if (inputState === "manual" || inputState === "suspended") throw new HerdrInputWaitingError("control_suspended", "Automatic input is waiting for explicit control handoff.");
      if (inputState !== "automation") throw new HerdrAgentActionError("The original input admission is not available.", "agent.prompt", "not-submitted", { promptSubmission: "not-submitted" });
      try { input.onPromptSubmitting?.(); } catch { /* Optional observation cannot alter input. */ }
      await send(context, prompt, operation, undefined, input.onPromptSubmitted, false, input.onPromptTransportCompleted);
      return confirmNativeSession(context, binding, operation);
    }),
    observe: (context, binding, operation, onAttached) => serialize(context, async () => {
      await attachRun(context, operation);
      const record = need(context), runKey = `${record.sessionId}/${current(record).run.executionGeneration}`;
      const observed = await adapter(record).tasks.observe(context, binding, operation);
      const publicationConfirmed = await publishObservedIdentity(context, observed, operation);
      if (pendingAttachmentPublications.has(runKey) && publicationConfirmed) {
        pendingAttachmentPublications.delete(runKey);
        try { onAttached?.(); } catch { /* Optional observation cannot alter attachment. */ }
      }
      return observed;
    }),
    submitPrompt: (context, binding, prompt, operation, guard, onTransportCompleted) => serialize(context, () => { if (canonicalSessionJson(binding) !== canonicalSessionJson(bindingFor(current(need(context))))) throw new SessionV2Error("target_changed"); return send(context, prompt, operation, guard, undefined, false, onTransportCompleted); }),
    submitInitialPrompt: (context, binding, prompt, operation, guard, onTransportCompleted) => serialize(context, () => { if (canonicalSessionJson(binding) !== canonicalSessionJson(bindingFor(current(need(context))))) throw new SessionV2Error("target_changed"); return send(context, prompt, operation, guard, undefined, true, onTransportCompleted); }),
    launch: async () => { throw new Error("Native launch must pass the durable Herdr admission path."); },
    processInfo: (context, binding, operation) => adapter(need(context)).tasks.processInfo(context, binding, operation),
    syncWorkspaceName: async (context, binding, title, operation) => { const record = need(context); if (record.runs.length > 0 && current(record).phase === "active") await adapter(record).tasks.syncWorkspaceName(context, binding, title, operation); },
    stopAndClose: (context, _binding, operation) => stop(context, "shutdown", operation),
  };
  return { ...legacy, tasks, ensureInstance: async () => ({ reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }),
    stopInstance: async () => { throw new Error("Durable Herdr runs must be stopped by their original process identities."); },
    input: {
      state: owner => getInput(owner).state(),
      control: (owner, message, operation) => getInput(owner).control(message, operation.signal),
      submit: (owner, message, operation) => getInput(owner).input(message, operation.signal),
      suspend: owner => { getInput(owner).suspend(); },
    },
    lifecycle: {
      migration: {
        listLifecycles: () => store.list(),
        listRetired: () => store.listRetired(),
        assertOrigin: record => {
          if (record.owner.serverOrigin !== options.serverOrigin || record.owner.workerId !== options.workerId) throw new Error("The original Herdr archive belongs to another server or worker and cannot be completely observed.");
        },
        listBindings: async (projectId, operation) => {
          const result = [];
          for (const record of store.list()) {
            if (record.owner.projectId !== projectId || record.runs.length === 0 || current(record).phase === "stopped_confirmed") continue;
            // Unlike the ordinary best-effort inventory, conversion cannot omit
            // an inaccessible original daemon and declare the format complete.
            result.push(...await adapter(record).tasks.listResources(operation));
          }
          return result;
        },
        listLegacyBindings: async operation => {
          await legacy.ensureInstance(operation);
          return legacy.tasks.listResources(operation);
        },
        listLegacyPendingStops: () => legacy.tasks.pendingStops(),
      },
      neverStarted: {
        candidates: () => store.list().filter(record => record.owner.serverOrigin === options.serverOrigin && record.owner.workerId === options.workerId && !store.retired(identity(record)) && isHerdrNeverStarted(record)).map(identity),
        retired: () => store.listRetired().filter(record => record.owner.serverOrigin === options.serverOrigin && record.owner.workerId === options.workerId).map(record => ({ owner: identity(record), cwd: record.cwd, agent: record.owner.provider })),
        retire: (owner, operation, verifyWorktreeAbsent) => serialize(owner, async () => {
          await settleSelection();
          const record = need(owner);
          if (!isHerdrNeverStarted(record)) throw new Error("The original claim has execution evidence; never-started retirement is prohibited.");
          if (!options.currentUserId || await options.currentUserId(operation.signal) !== record.owner.ownerUserId) throw new Error("Never-started retirement requires the original authenticated owner.");
          try {
            const task = await options.readTask(owner.projectId, owner.taskId, operation.signal), claim = readWorkerClaim(task.properties);
            if (task.projectId !== owner.projectId || task.id !== owner.taskId) throw new Error("The original task observation cannot prove claim termination.");
            // An absent or successor claim proves that the original claim lost ownership.
            if (claim && claim.claimId === record.claimId && (claim.state === "active" || claim.workerId !== record.owner.workerId || claim.worktreeId !== record.owner.worktreeId
              || claim.userId !== record.owner.ownerUserId || claim.agent !== record.owner.provider || claim.agentControlMode !== "herdr"
              || claim.nativeSessionId !== null || claim.herdr !== null)) throw new Error("The original never-started claim is not authoritatively terminal with matching ownership.");
          } catch (error) {
            if (!(error instanceof ApiError) || error.phase !== "response" || error.status !== 410 || error.code !== "task_deleted"
              || error.projectId !== owner.projectId || error.taskId !== owner.taskId || error.outcomeUnconfirmed) throw error;
          }
          const assertAbsent = (target: string): void => {
            try { lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
            throw new Error("The never-started claim still has filesystem resources; retirement is prohibited.");
          };
          const verifyOtherLocal = (): void => {
            operation.check();
            if (canonicalSessionJson(need(owner)) !== canonicalSessionJson(record)) throw new Error("The original lifecycle changed during never-started retirement.");
            if (inputStore.get(record.sessionId) !== null) throw new Error("The original claim has input evidence; retirement is prohibited.");
            assertAbsent(path.join(recordingRoot, record.sessionId));
            if (readdirSync(path.join(options.paths.workerDirectory, "herdr-archives")).some(name => name.startsWith(`${record.sessionId}.`))) throw new Error("The original claim has archive evidence; retirement is prohibited.");
          };
          verifyOtherLocal();
          await verifyWorktreeAbsent(record.cwd);
          // Git inspection may await subprocesses; fence every local observation again before the atomic decision.
          verifyOtherLocal(); assertAbsent(record.cwd);
          store.retireNeverStarted(record);
        }),
      },
      registerClaim: (context, ownerUserId) => {
        const previous = store.get(context);
        if (previous !== null) { need(context); return; }
        store.create({ owner: { projectId: context.projectId, taskId: context.taskId, workerId: options.workerId, worktreeId: context.worktreeId, ownerUserId, serverOrigin: options.serverOrigin, provider: context.agent }, claimId: context.claimId, cwd: context.cwd });
      },
      hasStarted: owner => {
        const record = store.get(owner);
        if (record === null || record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || record.owner.worktreeId !== owner.worktreeId) return true;
        return record.preparation !== null || record.runs.length > 0;
      },
      hasSubmittedExecution: owner => {
        const record = store.get(owner);
        if (record === null || record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || record.owner.worktreeId !== owner.worktreeId) return true;
        return record.runs.some(run => run.nativeLaunch !== "not_submitted");
      },
      assertCanAdvance: context => { const record = need(context); if (record.preparation !== null) throw new Error("The original Herdr preparation remains unconfirmed."); if (record.runs.length === 0) return; const run = current(record); if (run.run.stopProof !== null && isPreparedSessionV2StopProof(run.run.stopProof)) throw new Error("A stopped prepared runtime cannot grant native recovery or a replacement generation."); if (run.phase === "active" || run.phase === "prepared" && run.nativeLaunch === "not_submitted") return; assertHerdrRecovery({ phase: run.phase, nativeSessionId: run.run.binding.nativeSessionId, initialAssignment: recoveryInitialAssignment(record) }); },
      archive: resources,
      activeToolSelections: (): ActiveToolSelection[] => store.list().flatMap(record => {
        if (record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || store.retired(identity(record))) return [];
        const entries: ActiveToolSelection[] = [];
        for (const local of [...record.runs.filter(run => run.phase !== "stopped_confirmed"), ...(record.preparation === null ? [] : [record.preparation])]) {
          const uncertain = local.daemon === null || local.instanceObservation === undefined || local.phase !== "active" && local.phase !== "prepared";
          entries.push({ tool: "herdr", context: "herdr", launch: local.launches?.herdr ?? null, version: local.instanceObservation?.version ?? null, checkedAt: local.instanceObservation?.checkedAt ?? null, executionCount: 0, instanceCount: uncertain ? null : 1, unconfirmedCount: uncertain ? 1 : 0 });
          if (record.owner.provider !== "claude" && "nativeLaunch" in local && local.nativeLaunch !== "not_submitted") entries.push({ tool: record.owner.provider, context: "herdr", launch: local.launches?.agent ?? null, version: local.launches?.agentObservation?.version ?? null, checkedAt: local.launches?.agentObservation?.checkedAt ?? null, executionCount: uncertain ? null : 1, instanceCount: 0, unconfirmedCount: uncertain ? 1 : 0 });
        }
        return entries;
      }),
      responsibilities: () => retainedResources().map(resource => resource.owner),
      worktreePath: owner => {
        const record = store.get(owner);
        if (record === null) return null;
        if (record.owner.workerId !== options.workerId || record.owner.serverOrigin !== options.serverOrigin || record.owner.worktreeId !== owner.worktreeId) throw new Error("The original Herdr worktree path belongs to another execution owner.");
        return record.cwd;
      },
      hasPreparedRun: owner => { const record = store.get(owner); return record !== null && record.preparation === null && record.runs.at(-1)?.phase === "prepared"; },
      pendingInitialPrompt: owner => {
        const record = need(owner), input = inputStore.get(record.sessionId);
        return record.initialAssignment === "pending" && record.initialPrompt !== null && input !== null
          && input.target.sessionId === record.sessionId && input.target.claimId === record.claimId
          && input.initialOutcome === "pending" && input.initialDisposition === null && !input.unknownInput ? record.initialPrompt : null;
      },
      observeExecutionStop,
      isStopped: owner => { const record = store.get(owner); return selectionEpoch === settledSelectionEpoch && record !== null && record.preparation === null && (record.runs.length === 0 || record.runs.every(run => run.phase === "stopped_confirmed" && run.run.stopProof !== null)) && record.segments.every(segment => segment.endedAt !== null); },
      cleanup: async (owner, prompt, operation, scope) => {
        let notified = false;
        const record = need(owner);
        try { if (record.runs.at(-1)?.phase === "active" && record.segments.at(-1)?.endedAt === null) {
          const input = getInput(owner);
          const { canNotify } = input.beginClosing();
          if (canNotify) {
            const operationId = input.record().cleanupOperationId;
            update(owner, draft => { current(draft).admission = operationId; });
            try { notified = (await input.submit({ operationId, source: "cleanup", text: prompt }, operation.signal)).state === "transport_completed"; }
            finally { update(owner, draft => { current(draft).admission = null; }); }
          }
        } } catch { notified = false; }
        await stop(owner, "terminal", operation, scope);
        return notified;
      },
      stop,
      close: () => { recording.close(); inputSession.close(); inputStore.close(); store.close(); },
    },
  };
};
