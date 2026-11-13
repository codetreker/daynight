import { ConfigurationAdmissionWaiting, assertConfigurationAdmission } from "../../../src/commands/worker/configuration-admission.js";
import { ExecutionSourceConflictError, type TerminalCleanupContext } from "../../../src/commands/worker/execution-stop.js";
import { scanFromList } from "../../helpers/worker-git-scan.js";
import { createHash } from "node:crypto";
import * as inputSessionModule from "../../../src/commands/worker/herdr/input-session.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";
import { SESSION_V2_LIMITS } from "../../../src/session/v2/values.js";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import { openHerdrInputStore } from "../../../src/commands/worker/herdr/input-store.js";
import { inspectHerdrInput } from "../../../src/commands/worker/herdr/input-readiness.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Task } from "../../../src/api/types.js";
import { cleanupOperation } from "../../../src/commands/cleanup-operation.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { reconcileDeletedHerdrResource } from "../../../src/commands/worker/resource-disposal.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import { readWorkerClaim } from "../../../src/api/task-properties.js";
import { createExecutionDriver, type WorkerEvent, type WorkerGitManager } from "../../../src/commands/worker/execution.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createHerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import { createDurableWorkerHerdr } from "../../../src/commands/worker/herdr/durable.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import { HerdrInputBlockedError, HerdrInputWaitingError } from "../../../src/commands/worker/herdr/agents.js";
import { HerdrRpcError } from "../../../src/commands/worker/herdr/rpc.js";
import type { createWorkerHerdr, HerdrAgentObservation, HerdrExecutionContext, HerdrTaskBinding, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import { resolveHerdrInstancePaths } from "../../../src/commands/worker/herdr/instance.js";
import { herdrLedgerHash, openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { MacProcessControl, MacProcessObservation } from "../../../src/commands/worker/herdr/native-macos.js";
import type { HerdrSessionApi, HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import type { WorkerPaths } from "../../../src/commands/worker/paths.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";
import type { HerdrInputRecord } from "../../../src/commands/worker/herdr/input-types.js";
import { toolSelectionKey, type ResolvedToolLaunch } from "../../../src/platform/tool-executables.js";
import { recordedHerdrTools } from "./herdr-tool-snapshot.fixtures.js";
import type { NativeSelectionVerifier } from "../../../src/commands/worker/native-selection.js";

const cleanupScope = (owner: { projectId: string; taskId: string; claimId: string; worktreeId: string }): TerminalCleanupContext => ({ attempt: { owner, attemptId: "fixture" }, onExecutionStopped: () => {} });

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const root = fileURLToPath(new URL("../../../../../.tmp/herdr-durable-integration/", import.meta.url));
const directories: string[] = [], facades = new Set<WorkerHerdrAdapter>(), readers = new Set<HerdrLifecycleStore>(), operations: Operation[] = [];
const operation = (): Operation => { const result = createOperation({ limits: { totalMs: 3000 } }); operations.push(result); return result; };
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers(); operations.splice(0).forEach(value => value.dispose());
  for (const facade of facades) facade.lifecycle!.close(); facades.clear();
  for (const reader of readers) reader.close(); readers.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
type Registration = Extract<SessionV2Message, { type: "registration" }>;
type Ledger = Extract<SessionV2Message, { type: "generation_ledger" }>;
const workerExecutable = realpathSync(process.execPath);
const workerArtifact = { path: process.execPath, realPath: workerExecutable, size: String(statSync(workerExecutable).size), sha256: createHash("sha256").update(readFileSync(workerExecutable)).digest("hex") };
const frozenLaunch = (tool: "codex" | "herdr"): ResolvedToolLaunch => {
  const value = { schemaVersion: 1 as const, tool, context: "herdr" as const, source: "explicit" as const, entryPath: process.execPath, canonicalEntryPath: workerExecutable, executablePath: workerExecutable, interpreterPath: null, command: { file: workerExecutable, prefixArgs: [] }, artifacts: [{ role: "entry" as const, ...workerArtifact }] };
  return { ...value, selectionKey: toolSelectionKey(value) };
};
const fixture = (realInspector = false, driverResources = false, selectionVerifier?: NativeSelectionVerifier) => {
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const context: HerdrExecutionContext = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4), cwd: driverResources ? path.join(directory, "repo", ".worktrees", "daynight", uuid(2)) : directory, agent: "codex" };
  mkdirSync(context.cwd, { recursive: true });
  const ownerId = uuid(5), workerId = uuid(6), nativeId = uuid(7), serverOrigin = "https://daynight.example";
  const paths: WorkerPaths = { stateDirectory: directory, workerDirectory: path.join(directory, "worker"), configFile: path.join(directory, "config.yml"), databaseFile: path.join(directory, "worker.sqlite"), configurationFile: path.join(directory, "configuration.json"), lockFile: path.join(directory, "worker.lock"), herdrDirectory: path.resolve("/state/h"), logsDirectory: path.resolve("/state/logs"), temporaryDirectory: path.join(directory, "tmp") };
  let task: Task = { type: "task", parentId: null, id: context.taskId, projectId: context.projectId, title: "Original assignment", description: "Implement the assigned feature", tags: [], status: "in_progress", allowAgents: true, requiredPlatform: "macos", assignedTo: ownerId, startedAt: "2026-11-04T00:00:00Z", completedAt: null, cancelledAt: null, version: 1n, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
    properties: { worker: { claimId: context.claimId, state: "active", userId: ownerId, workerId, machine: { id: uuid(8), name: "test-machine" }, platform: "macos", agent: "codex", agentControlMode: "herdr", worktreeId: context.worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-04T00:00:00Z" } } };
  let frozenTools = { ...recordedHerdrTools(), agent: frozenLaunch("codex"), herdr: frozenLaunch("herdr") };
  const events: string[] = [], registrations: Registration[] = [], ledgers: Ledger[] = [], inputs: { initial: boolean; body: string }[] = [], launches: { resumeSessionId?: string }[] = [];
  const adapterSelectionVerifiers: (NativeSelectionVerifier | undefined)[] = [];
  const settings = { recordingBlocked: false, launchReceiptMissing: false, helperExited: false, unrelatedHelper: false, nativeStatus: "idle", nativeReady: true, nativeWrites: 0, nativeDraft: false, nativeScreen: "› Ask Codex to do anything\n GPT-6.1 Terra medium · daynight/task\n ? for shortcuts", nativeAtLaunch: false, nativeAfterInput: true, observeFailure: undefined as Error | undefined, observeAfterInputFailure: undefined as Error | undefined, observeFailureAfterCount: 1, inputUnknown: false, peerReplaced: false, stopUnknown: false, ledgerFailure: "none" as "none" | "before" | "after", prepareFailure: "none" as "none" | "before" | "after", recoveryFailure: "none" as "none" | "before" | "after" };
  const nativeReference = { source: "herdr:codex", sessionId: nativeId };
  const shellSettings = { managed: false, captureFailure: false };
  const launchOutcomes = { busyRejections: 0, unknown: false };
  let beforeDefiniteRetry: (() => void) | undefined;
  let beforePromptGuard: (() => void) | undefined;
  let beforeFrame: ((index: number) => void | Promise<void>) | undefined;
  let beforeInspect: ((purpose: string) => void | Promise<void>) | undefined;
  let taskReadFailure: Error | undefined;
  let beforeLaunchRetry: (() => void) | undefined;
  let recoveryDelay: ((stage: "publish" | "state" | "prepare", signal: AbortSignal | undefined) => Promise<void>) | undefined;
  const observed = new Map<number, MacProcessObservation>();
  type Local = { ordinal: number; paths: ReturnType<typeof resolveHerdrInstancePaths>; binding: HerdrTaskBinding; started: boolean; launched: boolean; nativeVisible: boolean; daemonPid: number; shellPid: number; agentPid: number; helperPid: number };
  const transmit = new Map<string, (initial: boolean, body: string) => Promise<unknown>>();
  const instances = new Map<string, Local>(); let sequence = 0, reader: HerdrLifecycleStore | undefined, facade: WorkerHerdrAdapter;
  const read = () => {
    reader ??= openHerdrLifecycleStore(path.join(paths.workerDirectory, "herdr-executions.sqlite"), { onMigration: () => {} }); readers.add(reader);
    const record = reader.get(context); if (!record) throw new Error("Missing test execution"); return record;
  };
  const proof = (pid: number, role: MacProcessIdentity["role"]): MacProcessIdentity => {
    const local = [...instances.values()].find(value => [value.daemonPid, value.shellPid, value.agentPid, value.helperPid].includes(pid));
    if (!local) throw new Error("Unexpected process identity");
    return { pid, role, birthToken: `1700000000:${pid}`, bootId: "boot-one", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: role === "daemon" ? 1 : role === "shell" ? local.daemonPid : pid === local.helperPid ? settings.unrelatedHelper ? 999 : local.shellPid : local.helperPid, pgid: role === "agent" ? local.helperPid : pid, sid: role === "daemon" ? pid : local.shellPid };
  };
  const native: MacProcessControl = {
    bootIdentity: async () => "boot-one",
    capture: async (pid, role, expected) => {
      events.push(`capture:${role}`);
      if (settings.helperExited && [...instances.values()].some(local => local.helperPid === pid)) throw new Error("Original helper exited before its birth identity was captured");
      if (expected) { expected.operation.check(); events.push(`image:${expected.executable}`); if (shellSettings.captureFailure) throw new Error("Unconfirmed final shell image"); expect(await expected.ready()).toBe(true); }
      return proof(pid, role);
    },
    observe: async value => observed.get(value.pid) ?? "same",
    peer: async endpoint => {
      const local = [...instances.values()].find(value => [value.paths.apiEndpoint, value.paths.clientEndpoint].includes(endpoint)); if (!local) throw new Error("Unknown endpoint");
      const value = proof(local.daemonPid, "daemon"); if (settings.peerReplaced) value.auditToken[7]! += 1; return value;
    },
    list: async () => [], signal: async () => { throw new Error("The facade must use the exclusive stop boundary"); },
    stopExclusiveRun: async (input, active) => {
      active.check();
      events.push("stop"); const record = read(), run = record.runs.at(-1)!;
      if (input.onDiscovered) { expect(run.phase).toBe("close_requested"); expect(run.stopOperationId).not.toBeNull(); }
      else { expect(run.run.stopProof).toBeNull(); }
      expect(run.daemon).toEqual(input.daemon); expect(run.processes).toEqual(input.processes);
      if (settings.stopUnknown || [input.daemon, ...input.processes].some(value => observed.get(value.pid) === "changed")) return { state: "stop_unknown", processes: [...input.processes], reason: "Original process identity changed" };
      for (const value of [input.daemon, ...input.processes]) observed.set(value.pid, "exited");
      return { state: "stopped_confirmed", processes: [...input.processes] };
    },
  };
  let remote: HerdrSessionState | undefined;
  let adjustControlRead: ((control: NonNullable<HerdrSessionState["control"]>) => void) | undefined;
  const stateView = () => {
    if (!remote) throw new Error("No remote state");
    const view = structuredClone(remote);
    // terminalState hides presentation actions while combined capabilities are gated.
    if (view.control && !Object.values(view.capabilities).every(Boolean)) view.control.availableActions = [];
    if (view.control) adjustControlRead?.(view.control);
    return view;
  };
  const recoveryReceipts = new Map<string, Extract<SessionV2Message, { type: "automation_recovery_state" }>>();
  const digestMessage = (value: unknown) => createHash("sha256").update(canonicalSessionJson(value)).digest("hex");
  const api: HerdrSessionApi = {
    verifySupport: async () => { events.push("support"); },
    current: async expected => remote ? stateView() : { status: "not_registered", protocol: "daynight.session.v2", claimId: expected.claimId, agentControlMode: "herdr" },
    register: async request => {
      registrations.push(structuredClone(request)); events.push(`register:${request.payload.mode}`);
      const connectionEpoch = request.payload.connectionEpoch === null ? "1" : String(BigInt(request.payload.connectionEpoch) + 1n);
      remote = { status: "registered", protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: request.sessionId, claimId: request.claimId, executionGeneration: request.executionGeneration, agentControlMode: "herdr", contentKind: "terminal_recording", owner: structuredClone(request.payload.owner), binding: structuredClone(request.payload.binding), connectionEpoch, connected: true, capabilities: request.payload.capabilities, control: remote?.control ? { ...remote.control, state: "suspended", lease: null, connectionEpoch, availableActions: [] } : null, snapshot: null, ledger: remote?.ledger ?? { runs: [], finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: remote?.recording ?? [] };
      return { ...request, type: "registration_ack", payload: { registrationId: request.payload.registrationId, connectionEpoch } };
    },
    ledger: async (request, epoch) => {
      if (!remote || remote.connectionEpoch !== epoch) throw new Error("Unregistered or stale connection");
      ledgers.push(structuredClone(request)); events.push(`ledger:${request.executionGeneration}`);
      if (settings.ledgerFailure === "before") throw new Error("Lost ledger before commit");
      if (remote.control && remote.executionGeneration !== request.executionGeneration) remote.control = { ...remote.control, state: "suspended", lease: null, availableActions: [] };
      remote = { ...remote, executionGeneration: request.executionGeneration, binding: structuredClone(request.payload.runs.at(-1)!.binding), ledger: structuredClone(request.payload) };
      if (settings.ledgerFailure === "after") throw new Error("Lost ledger response");
      return request;
    },
    publishControl: async (_expected, request, signal) => {
      await recoveryDelay?.("publish", signal);
      if (!remote || remote.connectionEpoch !== request.payload.connectionEpoch || remote.control && remote.control.state !== "automation" && request.payload.state === "automation") throw new Error("The retained service control is suspended");
      remote.control = structuredClone(request.payload); return structuredClone(request);
    },
    prepareRecovery: async (_expected, request, signal) => {
      await recoveryDelay?.("prepare", signal);
      events.push("prepare-post"); if (settings.prepareFailure === "before") throw new Error("Lost prepare before commit");
      if (!remote || remote.control?.state !== "automation" || remote.control.initialAssignment !== "transport_completed" || remote.control.controlEpoch !== request.payload.controlEpoch || remote.control.lease !== null) throw new Error("No clean service control");
      if (remote.executionGeneration !== request.executionGeneration || remote.connectionEpoch !== request.payload.connectionEpoch || canonicalSessionJson(remote.binding) !== canonicalSessionJson(request.payload.binding)) throw new Error("Recovery requires the exact published binding");
      const state: Extract<SessionV2Message, { type: "automation_recovery_state" }> = { ...request, type: "automation_recovery_state", payload: { recoveryId: request.payload.recoveryId, prepareDigest: digestMessage(request), sourceGeneration: request.executionGeneration, sourceConnectionEpoch: request.payload.connectionEpoch, sourceControlEpoch: request.payload.controlEpoch, closingControlEpoch: request.payload.closingControlEpoch, stopOperationId: request.payload.stopOperationId, nativeSessionId: request.payload.binding.nativeSessionId!, consumed: null } };
      recoveryReceipts.set(request.payload.recoveryId, structuredClone(state));
      remote.control = { ...remote.control, state: "closing", controlEpoch: request.payload.closingControlEpoch, availableActions: [] };
      events.push("recovery-prepared"); if (settings.prepareFailure === "after") throw new Error("Lost prepare response"); return state;
    },
    recoverAutomation: async (_expected, request) => {
      events.push("consume-post"); if (settings.recoveryFailure === "before") throw new Error("Lost consume before commit");
      const state = recoveryReceipts.get(request.payload.recoveryId), prior = remote?.ledger.runs.at(-2);
      if (!state || !remote || prior?.stopProof?.recordId !== request.payload.stopOperationId || prior.binding.nativeSessionId !== request.payload.binding.nativeSessionId || state.payload.consumed !== null || remote.control?.state !== "suspended") throw new Error("Invalid original service recovery");
      const result = { ...state, executionGeneration: request.executionGeneration, payload: { ...state.payload, consumed: { executionGeneration: request.executionGeneration, connectionEpoch: request.payload.connectionEpoch, controlEpoch: request.payload.controlEpoch, requestDigest: digestMessage(request) } } };
      recoveryReceipts.set(request.payload.recoveryId, structuredClone(result));
      remote.control = { ...remote.control, state: "automation", controlEpoch: request.payload.controlEpoch, connectionEpoch: request.payload.connectionEpoch, availableActions: ["acquire_control"] };
      events.push("recovery-consumed"); if (settings.recoveryFailure === "after") throw new Error("Lost consume response"); return result;
    },
    readRecovery: async (_expected, id) => {
      const state = recoveryReceipts.get(id); if (!state) throw new Error("No recorded service recovery"); return structuredClone(state);
    },
    state: async (_expected, signal) => {
      await recoveryDelay?.("state", signal);
      return stateView();
    },
  };
  const createAdapter: typeof createWorkerHerdr = options => {
    adapterSelectionVerifiers.push(options.selectionVerifier);
    let local = instances.get(options.paths.herdrDirectory);
    if (!local) { const ordinal = ++sequence; local = { ordinal, paths: resolveHerdrInstancePaths(options.paths), binding: { session: "w", workspaceId: `workspace-${ordinal}`, paneId: `pane-${ordinal}`, terminalId: `terminal-${ordinal}` }, started: false, launched: false, nativeVisible: false, daemonPid: ordinal * 100, shellPid: ordinal * 100 + 1, agentPid: ordinal * 100 + 2, helperPid: ordinal * 100 + 3 }; instances.set(options.paths.herdrDirectory, local); }
    const state = local;
    const observation = (): HerdrAgentObservation => ({ binding: state.binding, kind: state.launched ? "codex" : null, name: null, status: settings.nativeStatus, launchPending: false, interactiveReady: state.launched && settings.nativeReady, nativeSession: state.nativeVisible ? { ...nativeReference, agent: "codex" } : null, stateChangeSeq: 1, completionSeq: 0 });
    const input = async (initial: boolean, body: string) => {
      const record = read(), run = record.runs.at(-1)!;
      expect(run.phase).toBe("active"); expect(run.daemon).toEqual(proof(state.daemonPid, "daemon"));
      expect(run.processes).toEqual([proof(state.shellPid, "shell"), proof(state.helperPid, "agent"), proof(state.agentPid, "agent")]); expect(run.admission).not.toBeNull();
      expect(initial ? ["dispatching"] : ["transport_completed", "unknown"]).toContain(record.initialAssignment);
      events.push(initial ? "initial-input" : "continuation-input"); inputs.push({ initial, body });
      if (settings.inputUnknown) throw new HerdrAgentActionError("Lost input receipt", "agent.prompt", "unknown", { promptSubmission: "unknown" });
      state.nativeVisible = settings.nativeAfterInput;
      return { submission: "submitted" as const, observation: observation() };
    };
    transmit.set(state.paths.clientEndpoint, input);
    return {
      paths: state.paths, attachment: { executable: "herdr", arguments: [], environment: {}, unsetEnvironment: [] },
      get managedShellExecutable() { return shellSettings.managed ? "/bin/bash" as const : undefined; },
      createShellStartup: () => {
        if (!shellSettings.managed) return undefined;
        expect(state.started).toBe(true);
        return { nonce: uuid(900 + state.ordinal), executable: "/bin/bash" as const, isReady: async (pid: number) => { expect(pid).toBe(state.shellPid); events.push("shell-ready"); return true; } };
      },
      ensureInstance: async () => { if (!state.started) { events.push("daemon-launch"); expect(read().preparation?.phase).toBe("launch_requested"); await options.onDaemonSpawn?.(state.daemonPid); state.started = true; } return { reconnected: false, version: "0.9.5", protocol: 22, snapshot: {} }; },
      connectInstance: async () => { if (!state.started) throw new Error("The original daemon is not running"); return { reconnected: true, version: "0.9.5", protocol: 22, snapshot: {} }; },
      stopInstance: async () => { throw new Error("Unsafe daemon close must not be used"); },
      tasks: {
        observeExecutionStop: async target => ({ kind: "unknown", target, error: new Error("Not used by native lifecycle"), observedAt: Date.now() }),
        pendingStops: () => [], listResources: async () => driverResources && state.launched ? [{ owner: context, workspaceId: state.binding.workspaceId, panes: [{ ...observation(), kind: "codex" as const, cwd: context.cwd }] }] : [],
        prepareWorkspace: async (_context, _title, _operation, startup) => { expect(startup).toEqual(shellSettings.managed ? { shellNonce: uuid(900 + state.ordinal) } : undefined); events.push("workspace"); return state.binding; },
        syncWorkspaceName: async () => {}, observe: async () => { if (settings.observeFailure !== undefined) { const failure = settings.observeFailure; settings.observeFailure = undefined; throw failure; } if (inputs.length >= settings.observeFailureAfterCount && settings.observeAfterInputFailure !== undefined) { const failure = settings.observeAfterInputFailure; settings.observeAfterInputFailure = undefined; throw failure; } return observation(); },
        launchReceipt: async () => settings.launchReceiptMissing ? null : ({ schemaVersion: 1 as const, owner: { projectId: context.projectId, taskId: context.taskId, claimId: context.claimId, worktreeId: context.worktreeId }, nonce: uuid(999), selectionKey: read().runs.at(-1)!.launches!.agent!.selectionKey, logicalArgvDigest: "a".repeat(64), file: workerExecutable, prefixArgs: [], helperPid: state.helperPid, childPid: state.agentPid }),
        processInfo: async () => ({ shellPid: state.shellPid, foregroundPids: state.launched ? [state.agentPid] : [state.shellPid] }),
        launch: async (_context, _binding, request, active) => {
          await request.beforeStart?.(active);
          assertConfigurationAdmission(request.canAdmitNewExecution);
          request.onSubmitting?.();
          while (launchOutcomes.busyRejections > 0) {
            launchOutcomes.busyRejections--;
            const rejection = new HerdrAgentActionError("The original shell is still initializing.", "agent.start", "rejected", {
              cause: new HerdrRpcError("The target pane is busy.", { method: "agent.start", code: "agent_pane_busy", requestId: "busy", submission: "unknown" }),
            });
            request.onRejected?.(rejection);
            beforeDefiniteRetry?.();
            await request.beforeStart?.(active);
            assertConfigurationAdmission(request.canAdmitNewExecution);
            request.onSubmitting?.();
          }
          if (launchOutcomes.unknown) throw new HerdrAgentActionError("The original start response was lost.", "agent.start", "unknown");
          if (beforeLaunchRetry) { events.push("native-busy-attempt"); beforeLaunchRetry(); await request.beforeStart?.(active); }
          expect(read().runs.at(-1)?.phase).toBe("launch_requested"); events.push("native-launch"); launches.push(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}); state.launched = true; state.nativeVisible = request.resumeSessionId !== undefined || settings.nativeAtLaunch; return observation(); },
        start: async () => { throw new Error("Direct start would bypass durable admission"); },
        submitInitialPrompt: async (_context, _binding, body, _operation, beforeSubmit) => { beforePromptGuard?.(); if (beforeSubmit && !await beforeSubmit(_operation)) return { submission: "skipped", observation: observation() }; return input(true, body); },
        submitPrompt: async (_context, _binding, body, _operation, beforeSubmit) => { beforePromptGuard?.(); if (beforeSubmit && !await beforeSubmit(_operation)) return { submission: "skipped", observation: observation() }; return input(false, body); },
        stopAndClose: async () => { throw new Error("Herdr close must not replace original process stopping"); },
      },
    };
  };
  const reopen = (injectSessionApi = true) => {
    if (facade) { facade.lifecycle!.close(); facades.delete(facade); }
    facade = createDurableWorkerHerdr({ paths, homeDirectory: directory, serverOrigin, serverToken: "fixture-token", workerId, readTask: async () => { if (taskReadFailure) throw taskReadFailure; return task; }, processControl: native, readExecutionConfiguration: () => ({ agent: "codex", model: null, args: [], recoveryLimit: 3, agentControlMode: "herdr", toolLaunch: frozenTools.agent, toolObservation: frozenTools.agentObservation, herdrLaunch: frozenTools.herdr, herdrObservation: frozenTools.herdrObservation }), ...(selectionVerifier ? { selectionVerifier } : {}),
      readRecording: async (_record, signal) => {
        if (settings.recordingBlocked) await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { width: 1, height: 1, rows: [[]] };
      }, currentUserId: async () => ownerId,
      archiveApi: { ...createHerdrArchiveApi(serverOrigin, "fixture-token"), state: async () => stateView(), recording: async (_expected, message) => {
        const m = message as SessionV2Message;
        if (m.type !== "recording_responsibility" || !remote) throw new Error("Unexpected recording fixture message");
        remote.recording.push({ executionGeneration: m.executionGeneration, responsibility: m.payload, evidence: null }); return message;
      } },
      inspectInput: async request => {
        await beforeInspect?.(request.purpose);
        if (realInspector) return inspectHerdrInput({ ...request, readSize: async () => ({ width: 100, height: 24 }), rpc: { request: async method => {
          const local = [...instances.values()].find(value => value.binding.terminalId === request.binding.terminalId)!;
          const binding = local.binding;
          if (method === "ping") return { type: "pong", version: "0.9.5" };
          if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { panes: [{ pane_id: binding.paneId, terminal_id: binding.terminalId, workspace_id: binding.workspaceId, tab_id: "tab" }] } };
          if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: local.shellPid, tty: "/dev/ttys001" } };
          if (method === "pane.read") return { type: "pane_read", read: { pane_id: binding.paneId, workspace_id: binding.workspaceId, tab_id: "tab", source: "visible", format: request.purpose === "resume" ? "ansi" : "text", truncated: false, text: settings.nativeDraft ? "› a pending draft" : settings.nativeScreen } };
          throw new Error(`Unexpected readiness RPC: ${method}`);
        } } });
        if (request.purpose !== "manual" && settings.nativeDraft) throw new Error("The native composer now contains this batch's paste");
        return { width: 100, height: 24, herdrVersion: "0.9.5", composer: "empty" };
      },
      submitInput: async request => {
        beforePromptGuard?.();
        let written = false;
        try {
          for (const [index, part] of request.inputs.entries()) {
            await beforeFrame?.(index);
            await request.beforeWrite(); request.onWrite?.(); written = true;
            settings.nativeWrites += 1;
            settings.nativeDraft = part.kind === "paste";
          }
        } catch (error) { return { status: written ? "unknown" : "rejected", reason: String(error) }; }
        if (facade.input?.state(context).state === "manual") return { status: "transport_completed", reason: "detached" };
        try {
          const body = request.inputs.filter(input => input.kind === "paste").map(input => input.text).join("");
          await transmit.get(request.endpoint)!(read().initialAssignment === "dispatching", body);
          return { status: "transport_completed", reason: "detached" };
        } catch (error) { return { status: "unknown", reason: String(error) }; }
      }, ...(injectSessionApi ? { sessionApi: api } : {}), createAdapter }); facades.add(facade); return facade;
  };
  mkdirSync(paths.workerDirectory, { recursive: true });
  const initialStore = openHerdrLifecycleStore(path.join(paths.workerDirectory, "herdr-executions.sqlite"), { onMigration: () => {} }); initialStore.close();
  openHerdrInputStore(path.join(paths.workerDirectory, "herdr-inputs.sqlite"), { onMigration: () => {} }).close();
  reopen();
  const register = () => facade.lifecycle!.registerClaim(context, ownerId);
  const prepare = () => facade.tasks.prepareWorkspace(context, task.title, operation());
  const start = (binding: HerdrTaskBinding) => facade.tasks.start(context, binding, { configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment" }, operation());
  return { replaceToolTargets: () => { frozenTools = recordedHerdrTools(); }, context, paths, events, registrations, ledgers, inputs, launches, settings, shellSettings, launchOutcomes, observed, nativeId, nativeReference, api, read, stateView, register, prepare, start, reopen, adapterSelectionVerifiers, readTask: async () => task,
    removeLegacyToolSnapshot: () => {
      const database = new Database(path.join(paths.workerDirectory, "herdr-executions.sqlite"));
      try { database.prepare("UPDATE executions SET data = json_remove(data, '$.runs[0].launches', '$.runs[0].instanceObservation')").run(); }
      finally { database.close(); }
    },
    beforeDefiniteRetry: (hook: () => void) => { beforeDefiniteRetry = hook; },
    acknowledgeControl: (control: NonNullable<HerdrSessionState["control"]>) => { if (!remote) throw new Error("No remote state"); remote.control = structuredClone(control); },
    revealNative: () => { for (const local of instances.values()) if (local.launched) local.nativeVisible = true; },
    mutateRecord: (change: Parameters<HerdrLifecycleStore["update"]>[1]) => { const record = read(); return reader!.update(record, change); },
    get facade() { return facade; }, adjustControlRead: (hook: NonNullable<typeof adjustControlRead>) => { adjustControlRead = hook; }, recoveryDelay: (hook: NonNullable<typeof recoveryDelay>) => { recoveryDelay = hook; }, beforePromptGuard: (hook: () => void) => { beforePromptGuard = hook; }, beforeFrame: (hook: typeof beforeFrame) => { beforeFrame = hook; }, beforeInspect: (hook: typeof beforeInspect) => { beforeInspect = hook; }, failTaskRead: (error?: Error) => { taskReadFailure = error; }, beforeLaunchRetry: (hook: () => void) => { beforeLaunchRetry = hook; }, changeTask: (value: Partial<Task>) => { task = { ...task, ...value }; } };
};

describe("durable Herdr facade with real SQLite", () => {
  it("resumes the same unstarted run after a definite busy rejection and configuration outage", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(), original = f.read();
    let complete = true;
    f.launchOutcomes.busyRejections = 1;
    f.beforeDefiniteRetry(() => { complete = false; });
    await expect(f.facade.tasks.start(f.context, binding, {
      configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment", canAdmitNewExecution: () => complete,
    }, operation())).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    expect(f.read().runs[0]).toMatchObject({ phase: "prepared", nativeLaunch: "not_submitted", run: { executionGeneration: "1", binding: original.runs[0]!.run.binding } });
    expect(f.launches).toEqual([]); expect(f.inputs).toEqual([]);
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).not.toThrow();
    complete = true;
    const resumed = await f.prepare(); expect(resumed).toEqual(binding);
    await f.facade.tasks.start(f.context, resumed, {
      configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment", canAdmitNewExecution: () => complete,
    }, operation());
    expect(f.read().runs).toHaveLength(1);
    expect(f.read().sessionId).toBe(original.sessionId);
    expect(f.read().registrationId).toBe(original.registrationId);
    expect(f.launches).toHaveLength(1); expect(f.registrations).toHaveLength(1);
  });

  it("keeps an unknown native submission blocked when configuration recovers", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    f.launchOutcomes.unknown = true;
    await expect(f.start(binding)).rejects.toMatchObject({ submission: "unknown" });
    expect(f.read().runs[0]).toMatchObject({ phase: "launch_requested", nativeLaunch: "requested" });
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).toThrow();
    f.reopen(); f.launchOutcomes.unknown = false;
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).toThrow();
    expect(f.launches).toEqual([]);
  });

  it("keeps previous input history while a definite busy rejection retries original native recovery", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    const previous = f.read(); f.reopen(); const recoveryBinding = await f.prepare();
    f.launchOutcomes.busyRejections = 1;
    await f.facade.tasks.start(f.context, recoveryBinding, {
      configuration: { agent: "codex", model: null, args: [] }, prompt: "Continue the original task", canAdmitNewExecution: () => false,
    }, operation());
    expect(f.read().runs[0]).toEqual(previous.runs[0]);
    expect(f.read().runs[1]).toMatchObject({ phase: "active", nativeLaunch: "observed", run: { executionGeneration: "2", binding: { nativeSessionId: f.nativeId } } });
    expect(f.read().initialAssignment).toBe("transport_completed");
    expect(f.inputs.filter(input => input.initial)).toHaveLength(1);
    expect(f.launches).toEqual([{}, { resumeSessionId: f.nativeId }]);
  });

  it.each(["support", "current"] as const)("holds first Session registration when admission closes during %s verification", async stage => {
    const f = fixture(); f.register(); let complete = true;
    if (stage === "support") {
      const verify = f.api.verifySupport;
      f.api.verifySupport = async signal => { await verify(signal); complete = false; };
    } else {
      const current = f.api.current;
      f.api.current = async (...args) => { const result = await current(...args); if (f.read().runs.length > 0) complete = false; return result; };
    }
    let failure: unknown;
    try { await f.facade.tasks.prepareWorkspace(f.context, "Task", operation(), { canAdmitNewExecution: () => complete }); }
    catch (error) { failure = error; }
    expect(f.registrations).toEqual([]);
    expect(f.read()).toMatchObject({ connectionEpoch: null, registrationRequest: null, runs: [{ phase: "prepared", nativeLaunch: "not_submitted" }] });
    expect(failure).toBeInstanceOf(ConfigurationAdmissionWaiting);
  });

  it("carries admission through start publication of an already prepared first run", async () => {
    const f = fixture(); f.register(); const verify = f.api.verifySupport;
    f.api.verifySupport = async () => { throw new Error("Support temporarily unavailable."); };
    await expect(f.prepare()).rejects.toThrow("Support temporarily unavailable");
    expect(f.read().runs).toHaveLength(1); expect(f.registrations).toEqual([]);
    const binding = await f.prepare(); let complete = true;
    f.api.verifySupport = async signal => { await verify(signal); complete = false; };
    await expect(f.facade.tasks.start(f.context, binding, {
      configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment", canAdmitNewExecution: () => complete,
    }, operation())).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    expect(f.registrations).toEqual([]);
    expect(f.read()).toMatchObject({ connectionEpoch: null, registrationRequest: null, runs: [{ phase: "prepared", nativeLaunch: "not_submitted" }] });
    f.api.verifySupport = verify; complete = true;
    await f.facade.tasks.start(f.context, binding, {
      configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment", canAdmitNewExecution: () => complete,
    }, operation());
    expect(f.read().runs).toHaveLength(1); expect(f.registrations).toHaveLength(1); expect(f.launches).toHaveLength(1);
  });

  it("waits before first native preparation after configuration readiness changes during claim verification", async () => {
    const f = fixture(); f.register();
    let complete = true;
    const current = f.api.current.bind(f.api);
    vi.spyOn(f.api, "current").mockImplementation(async (...args) => { const result = await current(...args); complete = false; return result; });
    await expect(f.facade.tasks.prepareWorkspace(f.context, "Task", operation(), { canAdmitNewExecution: () => complete })).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    expect(f.read()).toMatchObject({ preparation: null, runs: [] });
    expect(f.events).not.toContain("daemon-launch");
    expect(f.facade.lifecycle!.hasSubmittedExecution!(f.context)).toBe(false);
  });

  it("keeps the original prepared run unsubmitted when readiness changes during prompt preparation", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    let complete = true;
    await expect(f.facade.tasks.start(f.context, binding, {
      configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment",
      canAdmitNewExecution: () => complete,
      preparePromptSource: async () => { await Promise.resolve(); complete = false; },
    }, operation())).rejects.toBeInstanceOf(ConfigurationAdmissionWaiting);
    expect(f.read().runs[0]).toMatchObject({ phase: "prepared", nativeLaunch: "not_submitted" });
    expect(f.launches).toEqual([]);
    expect(f.inputs).toEqual([]);
    complete = true;
    await f.start(binding);
    expect(f.launches).toHaveLength(1);
    expect(f.facade.lifecycle!.hasSubmittedExecution!(f.context)).toBe(true);
  });

  it("only permits checkout preparation when the original lifecycle proves it has not started", async () => {
    const f = fixture();
    expect(f.facade.lifecycle!.hasStarted!(f.context)).toBe(true);
    f.register();
    expect(f.facade.lifecycle!.hasStarted!(f.context)).toBe(false);
    expect(f.facade.lifecycle!.hasStarted!({ ...f.context, worktreeId: uuid(777) })).toBe(true);
    expect(f.facade.lifecycle!.migration!.listLifecycles()).toEqual([f.read()]);
    expect(() => f.facade.lifecycle!.migration!.assertOrigin(f.read())).not.toThrow();
    expect(() => f.facade.lifecycle!.migration!.assertOrigin({ ...f.read(), owner: { ...f.read().owner, serverOrigin: "https://foreign.example" } })).toThrow("another server or worker");
    expect(() => f.facade.lifecycle!.migration!.assertOrigin({ ...f.read(), owner: { ...f.read().owner, workerId: uuid(778) } })).toThrow("another server or worker");
    await f.prepare();
    expect(f.facade.lifecycle!.hasStarted!(f.context)).toBe(true);
  });
  it("keeps an unstarted preparation uncertain until its daemon handshake is recorded", async () => {
    const f = fixture(); f.register();
    f.mutateRecord(record => { record.preparation = { instanceId: uuid(991), instanceDirectory: path.join(f.context.cwd, "not-started"), phase: "prepared", daemon: null, launches: recordedHerdrTools() }; });
    expect(f.facade.lifecycle!.activeToolSelections!()).toEqual([expect.objectContaining({ tool: "herdr", instanceCount: null, unconfirmedCount: 1, version: null, checkedAt: null })]);
  });
  it("reports a prepared runtime from its persisted handshake", async () => {
    const f = fixture(); f.register(); await f.prepare();
    expect(f.facade.lifecycle!.activeToolSelections!()).toEqual([expect.objectContaining({ tool: "herdr", instanceCount: 1, unconfirmedCount: 0, version: "0.9.5", checkedAt: expect.any(String) })]);
    f.removeLegacyToolSnapshot();
    expect(f.facade.lifecycle!.activeToolSelections!()).toEqual([expect.objectContaining({ tool: "herdr", instanceCount: null, unconfirmedCount: 1, version: null, checkedAt: null })]);
  });
  it("freezes both launches before daemon submission and retains them for original-claim recovery", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    const launches = f.read().runs[0]!.launches;
    expect(launches).toMatchObject({ agent: { selectionKey: frozenLaunch("codex").selectionKey }, herdr: { selectionKey: frozenLaunch("herdr").selectionKey } });
    await f.start(binding); await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    f.replaceToolTargets(); f.reopen(); await f.prepare();
    expect(f.read().runs[1]!.launches).toEqual(launches);
  });
  it.each(["launchReceiptMissing", "helperExited", "unrelatedHelper"] as const)("keeps input closed when original launch proof is %s", async failure => {
    const f = fixture(); f.register(); const binding = await f.prepare(); f.settings[failure] = true;
    await expect(f.start(binding)).rejects.toThrow(/receipt|helper|chain|identity/i);
    expect(f.inputs).toEqual([]); expect(f.read().runs[0]!.phase).toBe("launch_requested");
    expect(f.read().runs[0]!.admission).toBeNull();
  });
  it("keeps legacy endpoint observation, input, and stopping without inventing launch identity", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    f.removeLegacyToolSnapshot(); f.replaceToolTargets();
    await f.facade.tasks.observe(f.context, binding, operation());
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Continue the original legacy session", operation())).resolves.toMatchObject({ submission: "submitted" });
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.read().runs[0]!).toMatchObject({ phase: "stopped_confirmed" });
    expect(f.read().runs[0]!.launches).toBeUndefined();
    expect(f.events.filter(value => value === "daemon-launch")).toHaveLength(1);
    expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(2);
  });
  it("reconnects a legacy runtime after restart and refuses a replacement generation", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    f.removeLegacyToolSnapshot(); f.replaceToolTargets(); f.reopen();
    await f.facade.tasks.observe(f.context, binding, operation());
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    await expect(f.prepare()).rejects.toMatchObject({ code: "legacy_tool_identity_missing" });
    expect(f.read().runs).toHaveLength(1); expect(f.read().preparation).toBeNull();
    expect(f.events.filter(value => value === "daemon-launch")).toHaveLength(1);
    expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
  });
  it("refuses an unsubmitted legacy run before native launch", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); f.removeLegacyToolSnapshot();
    await expect(f.start(binding)).rejects.toMatchObject({ code: "legacy_tool_identity_missing" });
    expect(f.read().runs[0]!).toMatchObject({ phase: "prepared", nativeLaunch: "not_submitted" });
    expect(f.launches).toEqual([]); expect(f.inputs).toEqual([]);
  });
  it("captures a fresh recovery input without replaying the original assignment", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    const next = await f.prepare();
    const preparePrompt = vi.fn((recovery: boolean) => recovery
      ? "Continue the original assigned task under its existing authorization.\n\n----- begin user prompt -----\nlatest\n----- end user prompt -----"
      : "unexpected original assignment");
    await f.facade.tasks.start(f.context, next, { configuration: { agent: "codex", model: null, args: [] }, prompt: "stale assignment", preparePrompt, canAdmitNewExecution: () => false }, operation());
    expect(preparePrompt).toHaveBeenCalledWith(true);
    expect(f.inputs.filter(value => value.initial)).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.inputs.filter(value => !value.initial)).toEqual([{ initial: false, body: expect.stringContaining("latest") }]);
    expect(f.inputs.at(-1)!.body).not.toContain("stale assignment");
    expect(f.read().initialPrompt).toBe("Original managed assignment");
  });
  it("keeps a durable native launch unsubmitted when fresh input preparation rejects", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    const failure = new Error("Prompt input is not ready");
    await expect(f.facade.tasks.start(f.context, binding, { configuration: { agent: "codex", model: null, args: [] }, prompt: "stale", preparePrompt: () => { throw failure; } }, operation())).rejects.toBe(failure);
    expect(f.launches).toEqual([]);
    expect(f.inputs).toEqual([]);
    expect(f.read()).toMatchObject({ initialAssignment: "pending", initialPrompt: null, runs: [expect.objectContaining({ phase: "prepared", nativeLaunch: "not_submitted" })] });
  });
  it("reuses a fixed unsubmitted initial prompt without fetching or rebuilding it", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    f.mutateRecord(record => { record.initialPrompt = "Previously fixed input"; });
    const preparePromptSource = vi.fn(async () => {}), preparePrompt = vi.fn(() => "New configuration text");
    await f.facade.tasks.start(f.context, binding, { configuration: { agent: "codex", model: null, args: [] }, prompt: "Other input", preparePromptSource, preparePrompt }, operation());
    expect(preparePromptSource).not.toHaveBeenCalled();
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(f.inputs).toEqual([{ initial: true, body: "Previously fixed input" }]);
    expect(f.read().initialPrompt).toBe("Previously fixed input");
  });
  it("shares one owned selection verifier across the legacy and per-run adapters", async () => {
    const f = fixture(); f.register(); await f.prepare();
    expect(f.adapterSelectionVerifiers.length).toBeGreaterThan(1);
    expect(f.adapterSelectionVerifiers[0]).toBeDefined();
    expect(new Set(f.adapterSelectionVerifiers).size).toBe(1);
  });

  it("does not let an older settle receipt clear a newer pending selection probe", async () => {
    let releaseSettle!: () => void, rejectVerify!: (error: Error) => void;
    const settle = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { releaseSettle = resolve; })).mockResolvedValue(undefined);
    const verify = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectVerify = reject; }));
    const f = fixture(false, false, { verify, settle, close: async () => {} }); f.register();
    const stopping = f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    const checking = f.adapterSelectionVerifiers[0]!.verify({ native: { agent: "codex", model: null, args: [] }, cwd: f.context.cwd, environment: {} }, operation());
    const rejected = expect(checking).rejects.toThrow("selection cleanup unconfirmed");
    const stopped = expect(stopping).rejects.toThrow("Native selection changed during cleanup");
    releaseSettle(); await stopped;
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    rejectVerify(new Error("selection cleanup unconfirmed")); await rejected;
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });

  it("allows concurrent task cleanup to settle the same probe generation", async () => {
    const releases: (() => void)[] = [];
    const settle = vi.fn(() => new Promise<void>(resolve => { releases.push(resolve); }));
    const f = fixture(false, false, { verify: async () => {}, settle, close: async () => {} }); f.register();
    const other = { ...f.context, taskId: uuid(92), claimId: uuid(93), worktreeId: uuid(94) };
    f.facade.lifecycle!.registerClaim(other, uuid(5));
    const stopping = Promise.all([f.facade.lifecycle!.stop(f.context, "shutdown", operation()), f.facade.lifecycle!.stop(other, "shutdown", operation())]);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(2));
    for (const release of releases) release();
    await stopping;
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
    expect(f.facade.lifecycle!.isStopped(other)).toBe(true);
  });

  it.each(["shutdown", "terminal"] as const)("attempts owned process stopping while shared probe cleanup is pending during %s", async reason => {
    let rejectCleanup!: (error: Error) => void;
    const cleanup = new Error("another task probe cleanup is unconfirmed");
    const settle = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectCleanup = reject; }));
    const f = fixture(false, false, { verify: async () => {}, settle, close: async () => {} });
    f.register(); const binding = await f.prepare(); await f.start(binding);
    const stopping = f.facade.lifecycle!.stop(f.context, reason, operation());
    const rejected = expect(stopping).rejects.toBe(cleanup);
    try { await vi.waitFor(() => expect(f.events).toContain("stop")); }
    finally { rejectCleanup(cleanup); await rejected; }
    expect(f.read().runs[0]!.phase).toBe("stopped_confirmed");
    expect(f.read().runs[0]!.run.stopProof).not.toBeNull();
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    expect(f.read().segments[0]!.endedAt).toBeNull();
  });

  it("retains both native stop and probe cleanup failures after attempting owned stopping", async () => {
    const cleanup = new Error("another task probe cleanup is unconfirmed");
    const f = fixture(false, false, { verify: async () => {}, settle: async () => { throw cleanup; }, close: async () => {} });
    f.register(); const binding = await f.prepare(); await f.start(binding);
    f.observed.set(f.read().runs[0]!.processes.find(proof => proof.role === "agent")!.pid, "changed");
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toMatchObject({ errors: [cleanup, expect.objectContaining({ message: expect.stringContaining("stop_unknown") })] });
    expect(f.events).toContain("stop");
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    expect(f.read().runs[0]!.run.stopProof).toBeNull();
  });

  it.each(["never-started", "prepared", "unconfirmed-preparation"])("retains %s resources until native selection probes have confirmed cleanup", async phase => {
    const settle = vi.fn().mockRejectedValue(new Error("selection cleanup unconfirmed"));
    const f = fixture(false, false, { verify: async () => {}, settle, close: async () => {} }); f.register();
    if (phase === "prepared") await f.prepare();
    if (phase === "unconfirmed-preparation") { f.shellSettings.managed = true; f.shellSettings.captureFailure = true; await expect(f.prepare()).rejects.toThrow("Unconfirmed final shell image"); }
    const original = f.read();
    const stopping = f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    if (phase === "unconfirmed-preparation") await expect(stopping).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "selection cleanup unconfirmed" }), expect.any(Error)] });
    else await expect(stopping).rejects.toThrow("selection cleanup unconfirmed");
    expect(settle).toHaveBeenCalledOnce(); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    expect(f.read().preparation).toEqual(original.preparation);
    if (phase === "prepared") {
      expect(f.events).toContain("stop");
      expect(f.read().runs[0]!.phase).toBe("stopped_confirmed");
      expect(f.read().runs[0]!.run.stopProof).toMatchObject({ nativeLaunch: "not_submitted" });
    } else { expect(f.read().runs).toEqual(original.runs); expect(f.events).not.toContain("stop"); }
    settle.mockResolvedValue(undefined);
    if (phase !== "unconfirmed-preparation") {
      await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
      expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
      if (phase === "prepared") expect(f.read().runs[0]!.run.stopProof).toMatchObject({ nativeLaunch: "not_submitted" });
    }
  });

  it("does not reinterpret unknown native launch as a prepared stop after probe cleanup succeeds", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const f = fixture(false, false, { verify: async () => {}, settle, close: async () => {} }); f.register(); await f.prepare();
    f.mutateRecord(record => { record.runs[0]!.phase = "launch_requested"; record.runs[0]!.nativeLaunch = "requested"; });
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow("stop_unknown");
    expect(settle).toHaveBeenCalledOnce(); expect(f.events).toContain("stop");
    expect(f.read().runs[0]!.nativeLaunch).toBe("requested"); expect(f.read().runs[0]!.run.stopProof).toBeNull();
  });

  it("reports the committed native stop before selection cleanup joins", async () => {
    let release!: () => void, notified!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const notification = new Promise<void>(resolve => { notified = resolve; });
    const settle = vi.fn().mockResolvedValue(undefined);
    const f = fixture(false, false, { verify: async () => {}, settle, close: async () => {} });
    f.register(); const binding = await f.prepare(); await f.start(binding);
    settle.mockImplementationOnce(() => barrier);
    const notices = vi.fn(() => notified());
    const scope = { attempt: { owner: f.context, attemptId: "attempt" }, onExecutionStopped: notices };
    const result = f.facade.lifecycle!.cleanup(f.context, "Cleanup now", operation(), scope);
    try {
      await notification;
      expect(f.read().runs.at(-1)?.run.stopProof).not.toBeNull();
      expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
      expect(notices).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ kind: "stopped", execution: expect.objectContaining({ backend: "herdr-native" }) }) }));
      expect(await f.facade.lifecycle!.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "stopped", execution: { backend: "herdr-native" } });
      expect(await f.facade.lifecycle!.observeExecutionStop({ ...f.context, worktreeId: uuid(999) }, operation())).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
    } finally { release(); await result; }
  });

  it("reports a replacement preparation as a conflict after the original stop", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(await f.facade.lifecycle!.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "stopped" });
    f.mutateRecord(record => { record.preparation = { instanceId: uuid(991), instanceDirectory: path.join(f.context.cwd, "replacement"), phase: "prepared", daemon: null, launches: record.runs.at(-1)!.launches! }; });
    expect(await f.facade.lifecycle!.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
  });

  it("reports never-started only from an exact empty lifecycle", async () => {
    const f = fixture(); f.register();
    expect(await f.facade.lifecycle!.observeExecutionStop(f.context, operation())).toMatchObject({ kind: "not-started", owner: expect.objectContaining({ claimId: f.context.claimId, worktreeId: f.context.worktreeId }) });
    expect(await f.facade.lifecycle!.observeExecutionStop({ ...f.context, worktreeId: uuid(999) }, operation())).toMatchObject({ kind: "unknown", error: expect.any(ExecutionSourceConflictError) });
  });

  it("fences terminal cleanup, archive disposal and never-started retirement on selection stop proof", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const f = fixture(false, false, { verify: async () => {}, settle, close: async () => {} }); f.register(); await f.prepare();
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    const proof = f.read().runs[0]!.run.stopProof;
    settle.mockRejectedValue(new Error("selection cleanup unconfirmed"));
    const onExecutionStopped = vi.fn();
    await expect(f.facade.lifecycle!.cleanup!(f.context, "cleanup", operation(), { ...cleanupScope(f.context), onExecutionStopped })).rejects.toThrow("selection cleanup unconfirmed");
    expect(onExecutionStopped).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ kind: "stopped" }) }));
    const remove = vi.fn().mockResolvedValue(undefined), target = { ...f.context, sessionId: f.read().sessionId };
    await expect(f.facade.lifecycle!.archive!.dispose({ ...target, operationId: uuid(99), action: "delete", confirmed: true }, operation(), remove)).rejects.toThrow("selection cleanup unconfirmed");
    await expect(f.facade.lifecycle!.archive!.advance(f.context, operation())).rejects.toThrow("selection cleanup unconfirmed");
    await expect(f.facade.lifecycle!.archive!.retry(target, operation())).rejects.toThrow("selection cleanup unconfirmed");
    expect(remove).not.toHaveBeenCalled(); expect(f.read().runs[0]!.run.stopProof).toEqual(proof);
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    expect(() => f.facade.lifecycle!.archive!.cleaned(f.context)).toThrow("cleanup is unconfirmed");
    const never = fixture(false, false, { verify: async () => {}, settle, close: async () => {} }); never.register();
    await expect(never.facade.lifecycle!.neverStarted!.retire(never.context, operation(), remove)).rejects.toThrow("selection cleanup unconfirmed");
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([true, false])("requires the final shell image only for a managed launcher: %s", async managed => {
    const f = fixture(); f.shellSettings.managed = managed; f.register(); await f.prepare();
    expect(f.events.filter(event => event.startsWith("image:"))).toEqual(managed ? ["image:/bin/bash"] : []);
    expect(f.events.filter(event => event === "shell-ready")).toHaveLength(managed ? 1 : 0);
    expect(f.read().runs[0]!.phase).toBe("prepared");
  });
  it("retains preparation without a run or service ledger when the final shell image is unconfirmed", async () => {
    const f = fixture(); f.shellSettings.managed = true; f.shellSettings.captureFailure = true; f.register();
    await expect(f.prepare()).rejects.toThrow("Unconfirmed final shell image");
    expect(f.read().preparation?.daemon).not.toBeNull(); expect(f.read().runs).toEqual([]);
    expect(f.ledgers).toEqual([]); expect(f.launches).toEqual([]); expect(f.inputs).toEqual([]);
  });
  it("reconnects an active run using its original identity without a new readiness acknowledgement", async () => {
    const f = fixture(); f.shellSettings.managed = true; f.register(); const binding = await f.prepare(); await f.start(binding);
    const original = f.read().runs[0]!.processes;
    f.reopen(); await f.facade.tasks.observe(f.context, binding, operation());
    expect(f.events.filter(event => event === "shell-ready")).toHaveLength(1);
    expect(f.read().runs[0]!.processes).toEqual(original);
  });
  it("continues a completed interactive turn through the real inspector while retaining input and process guards", async () => {
    const f = fixture(true); f.register(); const binding = await f.prepare(); await f.start(binding);
    expect(f.settings.nativeWrites).toBe(2);
    f.settings.nativeStatus = "working";
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Premature continuation", operation())).rejects.toThrow(/automation_suspended/);
    expect(f.settings.nativeWrites).toBe(2);
    f.settings.nativeStatus = "done";
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Completed-turn continuation", operation())).resolves.toMatchObject({ submission: "submitted" });
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }, { initial: false, body: "Completed-turn continuation" }]);
    expect(f.settings.nativeWrites).toBe(4);
    f.settings.nativeReady = false;
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Unready completion", operation())).rejects.toThrow(/automation_suspended/);
    expect(f.settings.nativeWrites).toBe(4);
    f.settings.nativeReady = true;
    f.observed.set(f.read().runs[0]!.processes.find(value => value.role === "shell")!.pid, "changed");
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Replaced process", operation())).rejects.toThrow(/changed/);
    expect(f.settings.nativeWrites).toBe(4);
  });
  it("keeps repeated known-menu refusals pending and retries the original body after same-state dismissal", async () => {
    const f = fixture(true); f.register(); const binding = await f.prepare();
    const menu = "Select model\n› 1. GPT-6.1 Terra\nenter default · s session · esc back";
    f.settings.nativeScreen = menu;
    await expect(f.start(binding)).rejects.toBeInstanceOf(HerdrInputBlockedError);
    const input = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(f.facade.tasks.submitPrompt(f.context, binding, "Must not replace the original body", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
        expect(f.read()).toMatchObject({ initialAssignment: "pending", automationBlocked: false, initialPrompt: "Original managed assignment" });
        expect(f.read().runs.at(-1)?.admission).toBeNull();
        expect(input.get(f.read().sessionId)).toMatchObject({ state: "automation", initialOutcome: "pending", unknownInput: false });
      }
      expect(f.inputs).toEqual([]); expect(f.settings.nativeWrites).toBe(0); expect(f.launches).toHaveLength(1);
      f.settings.nativeScreen = "Unknown normal layout without an empty-composer assertion";
      await expect(f.facade.tasks.submitPrompt(f.context, binding, "Still not the initial body", operation())).resolves.toMatchObject({ submission: "submitted" });
      expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
      expect(f.read()).toMatchObject({ initialAssignment: "transport_completed", automationBlocked: false });
      f.settings.nativeScreen = menu;
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(f.facade.tasks.submitPrompt(f.context, binding, "Waiting continuation", operation())).rejects.toBeInstanceOf(HerdrInputBlockedError);
        expect(f.read().runs.at(-1)?.admission).toBeNull();
      }
      f.settings.nativeScreen = "Unknown normal layout without an empty-composer assertion";
      await expect(f.facade.tasks.submitPrompt(f.context, binding, "Continuation after dismissal", operation())).resolves.toMatchObject({ submission: "submitted" });
      expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }, { initial: false, body: "Continuation after dismissal" }]);
      expect(f.settings.nativeStatus).toBe("idle"); expect(f.settings.nativeWrites).toBe(4);
    } finally { input.close(); }
  }, 15_000);
  it.each([0, 1])("preserves a paused first assignment at native frame %s", async frame => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    const originalTask = await f.readTask();
    f.beforeFrame(index => { if (index === frame) f.changeTask({ properties: { ...originalTask.properties, paused: true } }); });
    await expect(f.start(binding)).rejects.toThrow();
    const store = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try {
      const current = store.get(f.read().sessionId)!;
      expect(f.settings.nativeWrites).toBe(frame);
      expect(f.read().runs.at(-1)?.admission).toBeNull();
      if (frame === 0) {
        expect(f.read()).toMatchObject({ initialAssignment: "pending", initialPrompt: "Original managed assignment" });
        expect(current).toMatchObject({ initialOutcome: "pending", unknownInput: false });
        expect(current.operations.at(-1)?.result).toMatchObject({ state: "rejected", errorCode: "automation_suspended" });
        const initialOperationId = current.initialOperationId;
        f.beforeFrame(undefined); f.changeTask({ properties: originalTask.properties });
        await expect(f.facade.tasks.submitPrompt(f.context, binding, "Different text", operation())).resolves.toMatchObject({ submission: "submitted" });
        expect(store.get(f.read().sessionId)!.initialOperationId).toBe(initialOperationId);
        expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
      } else {
        expect(f.read().initialAssignment).toBe("unknown");
        expect(current).toMatchObject({ state: "suspended", initialOutcome: "unknown", unknownInput: true });
        expect(current.operations.at(-1)?.result).toMatchObject({ state: "unknown", errorCode: "input_unknown" });
        f.beforeFrame(undefined); f.changeTask({ properties: originalTask.properties });
        await expect(f.facade.tasks.submitPrompt(f.context, binding, "Do not replay", operation())).rejects.toThrow();
        expect(f.settings.nativeWrites).toBe(1); expect(f.inputs).toEqual([]);
        expect(store.get(f.read().sessionId)).toMatchObject({ state: "suspended", initialOutcome: "unknown", unknownInput: true });
      }
    } finally { store.close(); }
  });
  it.each(["readiness", "serialized queue"] as const)("rechecks pause after a %s wait before native writing", async boundary => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const originalTask = await f.readTask();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (boundary === "readiness") f.beforeInspect(async purpose => { if (purpose === "automatic") { enter(); await gate; } });
    else f.beforeFrame(async index => { if (index === 0) { enter(); await gate; } });
    const first = f.facade.tasks.submitPrompt(f.context, binding, "First continuation", operation());
    const firstResult = first.then(() => null, error => error);
    await entered;
    const secondResult = boundary === "serialized queue" ? f.facade.tasks.submitPrompt(f.context, binding, "Queued continuation", operation()).then(() => null, error => error) : null;
    expect(f.read().runs.at(-1)?.admission).not.toBeNull();
    f.changeTask({ properties: { ...originalTask.properties, paused: true } });
    f.beforeInspect(undefined); f.beforeFrame(undefined); release();
    expect(await firstResult).toMatchObject({ promptSubmission: "not-submitted" });
    if (secondResult) expect(await secondResult).toMatchObject({ promptSubmission: "not-submitted" });
    expect(f.settings.nativeWrites).toBe(2); expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.read().runs.at(-1)?.admission).toBeNull();
    const journal = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try { expect(journal.get(f.read().sessionId)!.operations.at(-1)?.result).toMatchObject({ state: "rejected", errorCode: "automation_suspended" }); }
    finally { journal.close(); }
    f.changeTask({ properties: originalTask.properties });
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Continuation after unpause", operation())).resolves.toMatchObject({ submission: "submitted" });
    expect(f.inputs).toHaveLength(2); expect(f.settings.nativeWrites).toBe(4);
  });
  it.each(["entry", "first frame"] as const)("reports a replaced daemon despite pause at %s", async boundary => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const task = await f.readTask();
    const replace = () => { f.settings.peerReplaced = true; f.changeTask({ properties: { ...task.properties, paused: true } }); };
    if (boundary === "entry") replace(); else f.beforeFrame(index => { if (index === 0) replace(); });
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Must not write", operation())).rejects.toThrow(boundary === "entry" ? /daemon was replaced/i : /target_changed/);
    expect(f.settings.nativeWrites).toBe(2); expect(f.inputs).toHaveLength(1);
    expect(f.read().runs.at(-1)?.admission).toBeNull();
    if (boundary === "first frame") {
      const journal = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
      try { expect(journal.get(f.read().sessionId)!.operations.at(-1)?.result).toMatchObject({ state: "rejected", errorCode: "target_changed" }); }
      finally { journal.close(); }
    }
  });
  it("preserves a task read failure after input admission before the first frame", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const failure = new Error("marked task read failure");
    f.beforeFrame(index => { if (index === 0) f.failTaskRead(failure); });
    const error = await f.facade.tasks.submitPrompt(f.context, binding, "Must not write", operation()).then(() => null, reason => reason as unknown);
    expect(error).toBeInstanceOf(HerdrAgentActionError); expect(error).not.toBeInstanceOf(HerdrInputWaitingError);
    expect(error).toMatchObject({ action: "agent.prompt", promptSubmission: "not-submitted", cause: failure });
    expect(f.settings.nativeWrites).toBe(2); expect(f.inputs).toHaveLength(1);
    expect(f.read().runs.at(-1)?.admission).toBeNull();
    const journal = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try { expect(journal.get(f.read().sessionId)!.operations.at(-1)?.result).toMatchObject({ state: "rejected", errorCode: "invalid_payload" }); }
    finally { journal.close(); }
  });
  it("permits the owner to control and use the paused terminal but requires explicit handback after unpause", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const originalTask = await f.readTask(); f.changeTask({ properties: { ...originalTask.properties, paused: true } });
    const input = f.facade.input!, record = f.read(); let seq = 200;
    const control = async (action: "acquire_control" | "renew_control" | "release_control" | "resume_automation", overrides: { actor?: string; epoch?: string; leaseId?: string | null; draftHandled?: boolean } = {}) => {
      const state = input.state(f.context), actorUserId = overrides.actor ?? uuid(5);
      const request = { operationId: uuid(seq++), connectionEpoch: record.connectionEpoch!, controlEpoch: overrides.epoch ?? state.controlEpoch, action, browserClientId: uuid(101), leaseId: overrides.leaseId === undefined ? state.lease?.leaseId ?? null : overrides.leaseId, draftHandled: overrides.draftHandled ?? action === "resume_automation", initialUnknownDisposition: null };
      const requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId, request })).digest("hex");
      const ack = await input.control(f.context, { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "control_dispatch", payload: { actorUserId, requestDigest, request } }, operation());
      if (ack.result.state === "transport_completed") f.acknowledgeControl(ack.controlState);
      return ack;
    };
    expect((await control("acquire_control")).result.state).toBe("transport_completed");
    expect((await control("renew_control", { actor: uuid(99) })).result.state).toBe("rejected");
    expect((await control("renew_control")).result.state).toBe("transport_completed");
    const store = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try {
      const target = store.get(record.sessionId)!.target;
      for (const [index, kind] of (["paste", "keys"] as const).entries()) {
        const state = input.state(f.context);
        const common = { operationId: uuid(seq++), connectionEpoch: target.connectionEpoch, segmentId: target.segmentId, binding: target.binding, controlEpoch: state.controlEpoch, leaseId: state.lease!.leaseId, leaseSeq: String(index + 1) };
        const payload = kind === "paste" ? { ...common, kind, payload: { text: "Manual guidance" } } : { ...common, kind, payload: { key: "Enter" as const } };
        const result = await input.submit(f.context, { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "operation", payload }, operation());
        expect(result).toMatchObject({ state: "transport_completed", errorCode: null });
      }
      expect((await control("release_control", { leaseId: uuid(999) })).result.state).toBe("rejected");
      expect((await control("release_control")).controlState.state).toBe("suspended");
      expect((await control("resume_automation")).result.state).toBe("rejected");
      expect((await f.readTask()).properties.paused).toBe(true);
      f.changeTask({ properties: originalTask.properties });
      expect(input.state(f.context).state).toBe("suspended");
      await expect(control("resume_automation", { draftHandled: false })).rejects.toThrow();
      expect(input.state(f.context).state).toBe("suspended");
      expect((await control("resume_automation")).controlState.state).toBe("automation");
    } finally { store.close(); }
  });
  it("keeps manual control across detach and blocks continuation until explicit handback", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const input = f.facade.input!;
    const record = f.read();
    const message = { protocol: "daynight.session.v2" as const, schemaVersion: 2 as const, projectionVersion: 1 as const, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr" as const, contentKind: "terminal_recording" as const, type: "control_dispatch" as const,
      payload: { actorUserId: uuid(5), requestDigest: "a".repeat(64), request: { operationId: uuid(100), connectionEpoch: record.connectionEpoch!, controlEpoch: input.state(f.context).controlEpoch, action: "acquire_control" as const, browserClientId: uuid(101), leaseId: null, draftHandled: false, initialUnknownDisposition: null } } };
    message.payload.requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId: message.payload.actorUserId, request: message.payload.request })).digest("hex");
    const ack = await input.control(f.context, message, operation());
    expect(ack.controlState.state).toBe("manual");
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Automatic continuation", operation())).rejects.toThrow();
    expect(f.inputs).toHaveLength(1);
    input.suspend(f.context);
    expect(input.state(f.context).state).toBe("suspended");
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Still automatic", operation())).rejects.toThrow();
    expect(f.inputs).toHaveLength(1);
  });
  it("revokes manual input before cleanup and never appends a cleanup prompt", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    f.facade.input!.suspend(f.context);
    expect(await f.facade.lifecycle!.cleanup!(f.context, "Cleanup now", operation(), cleanupScope(f.context))).toBe(false);
    expect(f.inputs).toHaveLength(1); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("suppresses a paused cleanup prompt while stopping the original run", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const task = await f.readTask(); f.changeTask({ properties: { ...task.properties, paused: true } });
    expect(await f.facade.lifecycle!.cleanup!(f.context, "Cleanup now", operation(), cleanupScope(f.context))).toBe(false);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("keeps manual menus usable and requires real styled empty input before explicit handback", async () => {
    const f = fixture(true); f.register(); const binding = await f.prepare(); await f.start(binding);
    const input = f.facade.input!, record = f.read();
    const control = async (action: "acquire_control" | "resume_automation", id: number) => {
      const state = input.state(f.context);
      const request = { operationId: uuid(id), connectionEpoch: record.connectionEpoch!, controlEpoch: state.controlEpoch, action, browserClientId: uuid(101), leaseId: state.lease?.leaseId ?? null, draftHandled: action === "resume_automation", initialUnknownDisposition: null };
      const actorUserId = uuid(5), requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId, request })).digest("hex");
      return input.control(f.context, { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "control_dispatch", payload: { actorUserId, requestDigest, request } }, operation());
    };
    f.settings.nativeScreen = "› 1. GPT-6.1 Terra\nenter default · s session · esc back";
    expect((await control("acquire_control", 150)).controlState.state).toBe("manual");
    input.suspend(f.context);
    f.settings.nativeScreen = "› Ask Codex to do anything\n\n ? for shortcuts";
    expect((await control("resume_automation", 151)).result.state).toBe("rejected");
    expect(input.state(f.context).state).toBe("suspended");
    f.settings.nativeScreen = "› \x1b[2mAsk Codex to do anything\x1b[0m\n\n ? for shortcuts";
    expect((await control("resume_automation", 152)).controlState.state).toBe("automation");
    expect(f.inputs).toHaveLength(1);
  });
  it("skips a known-menu cleanup notification while still stopping the original native run", async () => {
    const f = fixture(true); f.register(); const binding = await f.prepare(); await f.start(binding);
    f.settings.nativeScreen = "› 1. GPT-6.1 Terra\nenter default · s session · esc back";
    expect(await f.facade.lifecycle!.cleanup!(f.context, "Cleanup now", operation(), cleanupScope(f.context))).toBe(false);
    expect(f.inputs).toHaveLength(1); expect(f.settings.nativeWrites).toBe(2);
    expect(f.read().runs.at(-1)?.admission).toBeNull();
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("sends eligible cleanup through the same input journal before controlled stop", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    expect(await f.facade.lifecycle!.cleanup!(f.context, "Cleanup now", operation(), cleanupScope(f.context))).toBe(true);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }, { initial: false, body: "Cleanup now" }]);
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("does not ignore a caller's replacement terminal binding", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    await expect(f.facade.tasks.submitPrompt(f.context, { ...binding, terminalId: "replacement" }, "Continuation", operation())).rejects.toThrow();
    expect(f.inputs).toHaveLength(1);
  });
  it.each(["shell", "daemon", "peer", "claim"] as const)("rejects a native start retry after original %s evidence changes", async kind => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    f.beforeLaunchRetry(() => {
      if (kind === "peer") f.settings.peerReplaced = true;
      else if (kind === "claim") f.changeTask({ status: "done" });
      else {
        const run = f.read().runs[0]!;
        const proof = kind === "daemon" ? run.daemon! : run.processes.find(value => value.role === "shell")!;
        f.observed.set(proof.pid, "changed");
      }
    });
    await expect(f.start(binding)).rejects.toThrow(/original/i);
    expect(f.events.filter(value => value === "native-busy-attempt")).toHaveLength(1);
    expect(f.launches).toHaveLength(0); expect(f.inputs).toHaveLength(0);
    expect(f.read().runs[0]!.phase).toBe("launch_requested");
    f.reopen(); expect(f.read().runs[0]!.phase).toBe("stop_unknown");
  });

  it("uses the cleanup operation's five-minute budget for the stop ledger HTTP read", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    vi.useFakeTimers(); const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      signals.push(init!.signal!); init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    f.reopen(false); let failure: unknown;
    const result = cleanupOperation(op => f.facade.lifecycle!.stop(f.context, "terminal", op)).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(0); expect(signals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(signals[0]!.aborted).toBe(false); expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(269_999); expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await result;
    expect(signals[0]!.aborted).toBe(true); expect(failure).toMatchObject({ kind: "deadline" });
    expect(f.read().runs[0]!.phase).toBe("stopped_confirmed"); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("commits process proof and input admission before the first prompt without requiring a native session", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    expect(f.read().runs[0]!.run.binding.nativeSessionId).toBeNull();
    await f.start(binding);
    const record = f.read();
    expect(record.initialAssignment).toBe("transport_completed"); expect(record.runs[0]!.run.binding.nativeSessionId).toBe(f.nativeId);
    expect(record.segments).toHaveLength(1); expect(record.segments[0]!.endedAt).toBeNull();
    expect(f.events.indexOf("capture:agent")).toBeLessThan(f.events.indexOf("initial-input"));
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.registrations[0]!.payload.capabilities).toEqual({ observe: true, control: true, archive: true });
  });
  it("keeps the Session across shutdown and resumes the native conversation in a new generation", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const original = f.read(); await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true); expect(f.read().segments[0]!.endedAt).not.toBeNull();
    f.reopen(); const next = await f.prepare(); await f.start(next); const recovered = f.read();
    expect(recovered.sessionId).toBe(original.sessionId); expect(recovered.runs.map(run => run.run.executionGeneration)).toEqual(["1", "2"]);
    expect(f.launches).toEqual([{}, { resumeSessionId: f.nativeId }]);
    expect(recovered.segments[1]!.gap).toMatchObject({ kind: "boundary", reason: "restart", from: { executionGeneration: "1" }, to: { executionGeneration: "2" } });
    expect(f.inputs.filter(input => input.initial)).toHaveLength(1); expect(f.inputs.filter(input => !input.initial)).toHaveLength(1);
  });
  it.each([true, false])("prepares recovery with gated presentation and native identity known at launch %s", async nativeAtLaunch => {
    const f = fixture(); f.settings.nativeAtLaunch = nativeAtLaunch; f.register(); const binding = await f.prepare(); await f.start(binding);
    expect(f.stateView().binding.nativeSessionId).toBe(f.nativeId);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.stateView().control?.availableActions).toEqual([]);
    expect(f.events).toContain("recovery-prepared");
    const publication = f.ledgers.findIndex(message => message.payload.runs.at(-1)?.binding.nativeSessionId === f.nativeId && message.payload.runs.at(-1)?.stoppedAt === null);
    expect(publication).toBeGreaterThanOrEqual(0);
    f.reopen(); const next = await f.prepare(); await f.start(next);
    expect(f.inputs.filter(value => value.initial)).toHaveLength(1);
    expect(f.inputs.filter(value => !value.initial)).toHaveLength(1);
  });
  it.each(["before", "after"] as const)("observes an enriched ledger lost %s commit without replaying it", async boundary => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    const ledger = f.api.ledger;
    f.api.ledger = (...args) => { if (args[0].payload.runs.at(-1)!.binding.nativeSessionId !== null) f.settings.ledgerFailure = boundary; return ledger(...args); };
    const started = f.start(binding);
    if (boundary === "before") await expect(started).rejects.toThrow(/unconfirmed|conflicts/);
    else await started;
    expect(f.read().initialAssignment).toBe("transport_completed");
    const enrichmentPosts = () => f.ledgers.filter(message => message.payload.runs.at(-1)?.binding.nativeSessionId === f.nativeId && message.payload.runs.at(-1)?.stoppedAt === null);
    expect(enrichmentPosts()).toHaveLength(1);
    f.api.ledger = ledger; f.settings.ledgerFailure = "none";
    if (boundary === "before") {
      await expect(f.facade.tasks.observe(f.context, binding, operation())).rejects.toThrow(/unconfirmed|conflicts/);
      await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/unconfirmed|conflicts/);
      expect(enrichmentPosts()).toHaveLength(1);
    } else {
      await f.facade.tasks.observe(f.context, binding, operation());
      expect(enrichmentPosts()).toHaveLength(1);
      await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
      f.reopen();
      const next = await f.prepare(); await f.start(next);
      expect(f.inputs.filter(value => !value.initial)).toHaveLength(1);
    }
    expect(f.inputs.filter(value => value.initial)).toHaveLength(1);
    expect(f.events).toContain("stop"); expect(f.read().runs[0]!.run.stopProof).not.toBeNull();
    expect(f.events.filter(value => value === "prepare-post")).toHaveLength(boundary === "after" ? 1 : 0);
  });
  it.each(["connectionEpoch", "controlEpoch", "state", "lease", "initialAssignment", "unavailableReason"] as const)("does not ignore differing recovery authority field %s", async field => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    f.adjustControlRead(control => {
      if (field === "connectionEpoch" || field === "controlEpoch") control[field] = "99";
      else if (field === "state") control.state = "suspended";
      else if (field === "initialAssignment") control.initialAssignment = "pending";
      else if (field === "unavailableReason") control.unavailableReason = "input_unknown";
      else control.lease = { leaseId: uuid(80), holderUserId: uuid(81), browserClientId: uuid(82), controlEpoch: control.controlEpoch, expiresAt: "2026-11-04T00:00:30.000Z" };
    });
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.events).toContain("stop"); expect(f.events).not.toContain("prepare-post");
  });
  it.each(["prepare", "consume"] as const)("reconciles a lost %s response without replay against retained service control", async boundary => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    if (boundary === "prepare") f.settings.prepareFailure = "after";
    else f.settings.recoveryFailure = "after";
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    const next = await f.prepare(); await f.start(next);
    expect(f.events.filter(value => value === "prepare-post")).toHaveLength(1);
    expect(f.events.filter(value => value === "consume-post")).toHaveLength(1);
    expect(f.inputs.filter(value => !value.initial)).toHaveLength(1);
  });
  it.each(["publish", "state"] as const)("reserves native stop time when recovery %s consumes the shared ten-second budget", async stalled => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    vi.useFakeTimers();
    let blocked = false, published = false;
    f.recoveryDelay(async (stage, signal) => {
      signal!.throwIfAborted();
      if (stalled === "state" && stage === "publish") { await new Promise<void>(resolve => setTimeout(resolve, 6000)); published = true; }
      else if (stage === stalled && !blocked && (stalled !== "state" || published)) { blocked = true; await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })); }
    });
    let completed = false, failure: unknown;
    const pending = cleanupOperation(active => f.facade.lifecycle!.stop(f.context, "shutdown", active)).then(() => { completed = true; }, error => { failure = error; });
    await vi.advanceTimersByTimeAsync(10_000);
    const stoppedWithinBudget = f.events.includes("stop"), finishedWithinBudget = completed;
    await vi.advanceTimersByTimeAsync(290_000); await pending;
    expect(stoppedWithinBudget).toBe(true); expect(finishedWithinBudget).toBe(true); expect(failure).toBeUndefined();
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("honors parent cancellation while waiting for shutdown recovery permission", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    f.recoveryDelay(async (_stage, signal) => {
      signal!.throwIfAborted(); entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const controller = new AbortController();
    const pending = cleanupOperation(active => f.facade.lifecycle!.stop(f.context, "shutdown", active), controller.signal);
    await ready; controller.abort(); await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    expect(f.events).not.toContain("stop"); expect(f.read().runs[0]!.run.stopProof).toBeNull();
  });
  it.each(["prepare", "consume"] as const)("never resends an unconfirmed %s intent or sends continuation", async boundary => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    if (boundary === "prepare") f.settings.prepareFailure = "before";
    else f.settings.recoveryFailure = "before";
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    const next = await f.prepare(); await expect(f.start(next)).rejects.toThrow(/recovery/);
    f.reopen(); await f.prepare();
    expect(f.events.filter(value => value === "prepare-post")).toHaveLength(1);
    expect(f.events.filter(value => value === "consume-post")).toHaveLength(boundary === "consume" ? 1 : 0);
    expect(f.inputs.filter(value => !value.initial)).toHaveLength(0);
  });
  const interruptInitialCommit = async (boundary: "input" | "lifecycle", nativeAtLaunch = true) => {
    const f = fixture(); f.settings.nativeAtLaunch = nativeAtLaunch; f.register(); const binding = await f.prepare();
    const input = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    const exec = Database.prototype.exec; let failed = false;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (!failed && sql === "BEGIN IMMEDIATE" && this.name.endsWith(boundary === "input" ? "herdr-inputs.sqlite" : "herdr-executions.sqlite") && f.inputs.length === 1 && f.read().initialAssignment === "dispatching" && input.get(f.read().sessionId)?.initialOutcome === (boundary === "input" ? "dispatching" : "transport_completed")) {
        failed = true; throw new Error("Interrupted initial receipt commit");
      }
      return exec.call(this, sql);
    });
    try { await expect(f.start(binding)).rejects.toThrow(boundary === "input" ? /unknown/ : /Interrupted initial receipt commit/); }
    finally { failure.mockRestore(); input.close(); }
    expect(failed).toBe(true); f.reopen(); return { f, binding };
  };
  it.each([true, false])("recovers a committed input receipt across the lifecycle commit gap with early native identity %s", async nativeAtLaunch => {
    const { f, binding } = await interruptInitialCommit("lifecycle", nativeAtLaunch);
    expect(f.read().initialAssignment).toBe("unknown");
    if (!nativeAtLaunch) await f.facade.tasks.observe(f.context, binding, operation());
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).not.toThrow();
    for (let generation = 2; generation <= 3; generation++) {
      const next = await f.prepare(); await f.start(next);
      expect(f.read().runs.at(-1)!.run.executionGeneration).toBe(String(generation));
      expect(f.read().initialAssignment).toBe("unknown");
      await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    }
    expect(f.inputs.filter(input => input.initial)).toHaveLength(1);
    expect(f.inputs.filter(input => !input.initial)).toHaveLength(2);
    expect(f.launches).toEqual([{}, { resumeSessionId: f.nativeId }, { resumeSessionId: f.nativeId }]);
  });
  it("does not infer delivery when native input completed but its own receipt commit failed", async () => {
    const { f } = await interruptInitialCommit("input");
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).toThrow(/unconfirmed|unknown/);
    await expect(f.prepare()).rejects.toThrow(/unconfirmed|unknown/);
    expect(f.inputs).toHaveLength(1); expect(f.launches).toHaveLength(1);
    const input = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try { expect(input.get(f.read().sessionId)!.initialOutcome).toBe("unknown"); }
    finally { input.close(); }
  });
  it.each(["session", "claim", "generation", "segment", "terminal", "native", "epoch", "digest", "operation", "journal-target"] as const)("refuses a lifecycle-gap receipt with stale %s evidence", async field => {
    const { f } = await interruptInitialCommit("lifecycle");
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    const db = new Database(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try {
      const row = db.prepare("SELECT data FROM input_sessions WHERE session_id = ?").get(f.read().sessionId) as { data: string };
      const input = JSON.parse(row.data) as HerdrInputRecord, receipt = input.operations.find(value => value.source === "initial")!;
      // Model an independently restored input journal that does not belong to
      // the lifecycle's original prompt, terminal, or generation history.
      if (field === "session" || field === "claim") {
        const key = field === "session" ? "sessionId" : "claimId";
        input.target[key] = uuid(999); for (const op of input.operations) op.target[key] = uuid(999);
      } else if (field === "generation") receipt.target.executionGeneration = "99";
      else if (field === "segment") receipt.target.segmentId = uuid(999);
      else if (field === "terminal") receipt.target.binding.terminalId = "replacement";
      else if (field === "native") receipt.target.binding.nativeSessionId = uuid(999);
      else if (field === "epoch") receipt.target.connectionEpoch = "999";
      else if (field === "digest") receipt.digest = "f".repeat(64);
      else if (field === "operation") input.initialAttemptOperationId = uuid(999);
      else input.target.binding.terminalId = "replacement";
      db.prepare("UPDATE input_sessions SET data = ? WHERE session_id = ?").run(JSON.stringify(input), f.read().sessionId);
    } finally { db.close(); }
    const refusal = ["session", "claim"].includes(field) ? /another original execution/ : /unconfirmed/;
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).toThrow(refusal);
    await expect(f.prepare()).rejects.toThrow(refusal);
    expect(f.inputs).toHaveLength(1); expect(f.launches).toHaveLength(1);
    expect(f.read().initialAssignment).toBe("unknown");
  });
  it("reconnects an existing live run with a new segment and no extra native launch", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding); const original = f.read();
    f.reopen(); await f.prepare(); await f.facade.tasks.observe(f.context, binding, operation());
    const recovered = f.read(); expect(recovered.sessionId).toBe(original.sessionId); expect(recovered.runs).toHaveLength(1);
    expect(recovered.connectionEpoch).toBe("2"); expect(recovered.segments).toHaveLength(2); expect(recovered.segments[0]!.endedAt).not.toBeNull();
    expect(recovered.segments[1]!.executionGeneration).toBe("1"); expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
  });
  it("refuses recovery when the original native session never became known", async () => {
    const f = fixture(); f.settings.nativeAfterInput = false; f.register(); const binding = await f.prepare(); await expect(f.start(binding)).rejects.toThrow();
    expect(f.read().initialAssignment).toBe("transport_completed"); expect(f.inputs).toHaveLength(1);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    await expect(f.prepare()).rejects.toThrow(/native.*identity|native.*session/i); expect(f.launches).toHaveLength(1);
  });
  it("waits for the original official Session after exactly one authorized initial input", async () => {
    const f = fixture(); f.settings.nativeAfterInput = false; f.register(); const binding = await f.prepare();
    let completed = false;
    const starting = f.start(binding).then(value => { completed = true; return value; });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(completed).toBe(false); expect(f.read().initialAssignment).toBe("transport_completed");
    f.revealNative();
    await expect(starting).resolves.toMatchObject({ nativeSession: { source: "herdr:codex", sessionId: f.nativeId } });
    expect(f.inputs).toHaveLength(1); expect(f.launches).toHaveLength(1);
  });
  it("keeps a delivered initial input recorded when native identity confirmation times out", async () => {
    const f = fixture(); f.settings.nativeAfterInput = false; f.register(); const binding = await f.prepare();
    const short = createOperation({ limits: { totalMs: 180 } }); operations.push(short);
    await expect(f.facade.tasks.start(f.context, binding, { configuration: { agent: "codex", model: null, args: [] }, prompt: "Original managed assignment" }, short)).rejects.toThrow();
    expect(f.inputs).toHaveLength(1); expect(f.read().initialAssignment).toBe("transport_completed");
    f.reopen();
    await expect(f.facade.tasks.submitInitialPrompt(f.context, binding, "Do not repeat", operation())).resolves.toMatchObject({ submission: "skipped" });
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Do not continue", operation())).rejects.toMatchObject({ reason: "native_session_pending" });
    expect(f.inputs).toHaveLength(1); expect(f.launches).toHaveLength(1);
  });
  it("rejects a replaced process while waiting for the original official Session", async () => {
    const f = fixture(); f.settings.nativeAfterInput = false; f.register(); const binding = await f.prepare();
    const starting = f.start(binding), rejection = expect(starting).rejects.toThrow(/process.*changed/i);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    f.observed.set(f.read().runs[0]!.processes.find(value => value.role === "agent")!.pid, "changed");
    f.revealNative(); await rejection;
    expect(f.read().initialAssignment).toBe("transport_completed"); expect(f.inputs).toHaveLength(1); expect(f.launches).toHaveLength(1);
  });
  it("never stores an identity from another native Session source", async () => {
    const f = fixture(); f.nativeReference.source = "manual:codex"; f.register(); const binding = await f.prepare();
    await expect(f.start(binding)).rejects.toThrow(/official Herdr integration/i);
    expect(f.read().runs[0]!.run.binding.nativeSessionId).toBeNull();
    expect(f.inputs).toHaveLength(1); expect(f.read().initialAssignment).toBe("transport_completed");
  });
  it("refuses recovery when the original hook reports another native Session", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen(); const next = await f.prepare();
    f.nativeReference.sessionId = uuid(999);
    await expect(f.start(next)).rejects.toThrow(/identity changed/i);
    expect(f.read().runs.at(-1)!.run.binding.nativeSessionId).toBe(f.nativeId);
    expect(f.inputs).toHaveLength(1); expect(f.launches).toEqual([{}, { resumeSessionId: f.nativeId }]);
  });
  it("retains unknown first input across restart and never automatically repeats it", async () => {
    const f = fixture(); f.settings.inputUnknown = true; f.register(); const binding = await f.prepare();
    await expect(f.start(binding)).rejects.toThrow(/unknown/); expect(f.read().initialAssignment).toBe("unknown");
    f.reopen(); await expect(f.facade.tasks.submitPrompt(f.context, binding, "Retry", operation())).rejects.toThrow(/admission/i);
    expect(f.inputs).toHaveLength(1); expect(f.read().initialAssignment).toBe("unknown");
  });
  it("rejects input for a replaced daemon and retains unknown stop responsibility", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    f.settings.peerReplaced = true;
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Continuation", operation())).rejects.toThrow(/replaced/i);
    f.observed.set(f.read().runs[0]!.daemon!.pid, "changed");
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    expect(f.read().runs[0]!.phase).toBe("stop_unknown"); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false); expect(f.inputs).toHaveLength(1);
  });
  it("confirms prepared resources stopped without fabricating an agent or replaying launch", async () => {
    const f = fixture(); f.register(); await f.prepare();
    const original = f.read().runs[0]!;
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    const stopped = f.read().runs[0]!;
    expect(stopped).toMatchObject({ phase: "stopped_confirmed", nativeLaunch: "not_submitted" });
    expect(stopped.run.stopProof).toMatchObject({ nativeLaunch: "not_submitted", daemon: { pid: original.daemon!.pid, birthToken: original.daemon!.birthToken, bootId: "boot-one" }, processes: [{ role: "shell", pid: original.processes[0]!.pid }] });
    expect(stopped.run.segmentIds).toEqual([]); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
    expect(f.ledgers.at(-1)!.payload.runs[0]!.stopProof).toEqual(stopped.run.stopProof);
    f.reopen(); await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.read().runs[0]).toEqual(stopped); expect(f.events.filter(value => value === "stop")).toHaveLength(1);
    await expect(f.prepare()).rejects.toThrow(/prepared|native.*identity|native.*session|input journal/i);
    expect(f.launches).toHaveLength(0); expect(f.inputs).toHaveLength(0);
  });
  it("keeps prepared provenance across an unconfirmed stop and completes only after original stopping succeeds", async () => {
    const f = fixture(); f.register(); await f.prepare(); f.settings.stopUnknown = true;
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    const pending = f.read().runs[0]!;
    expect(pending).toMatchObject({ phase: "stop_unknown", nativeLaunch: "not_submitted", run: { stopProof: null } });
    f.reopen(); f.settings.stopUnknown = false;
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.read().runs[0]).toMatchObject({ phase: "stopped_confirmed", nativeLaunch: "not_submitted", stopOperationId: pending.stopOperationId });
    expect(f.launches).toHaveLength(0); expect(f.inputs).toHaveLength(0);
  });
  it("does not confirm prepared stopping when the daemon disappeared before a durable stop intent", async () => {
    const f = fixture(); f.register(); await f.prepare(); f.observed.set(f.read().runs[0]!.daemon!.pid, "exited");
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    expect(f.read().runs[0]).toMatchObject({ phase: "stop_unknown", nativeLaunch: "not_submitted", run: { stopProof: null } });
    expect(f.events.filter(value => value === "stop")).toHaveLength(0);
  });
  it("does not grant another generation from stopped preparation with an inherited native identity", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    await f.prepare(); expect(f.read().runs).toHaveLength(2);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    expect(() => f.facade.lifecycle!.assertCanAdvance(f.context)).toThrow();
    await expect(f.prepare()).rejects.toThrow(/prepared.*recovery|prepared.*generation/i);
    expect(f.read().runs).toHaveLength(2); expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
  });
  it("retains requested launch uncertainty when only the original shell can be stopped", async () => {
    const f = fixture(); f.register(); await f.prepare();
    f.mutateRecord(draft => { const run = draft.runs[0]!; run.phase = "launch_requested"; run.nativeLaunch = "requested"; });
    f.reopen();
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    expect(f.read().runs[0]).toMatchObject({ phase: "stop_unknown", nativeLaunch: "requested", run: { stopProof: null } });
    expect(f.launches).toHaveLength(0); expect(f.inputs).toHaveLength(0);
  });
  it("does not recover or send input after losing the original claim", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding); f.changeTask({ allowAgents: false });
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Continuation", operation())).rejects.toThrow(/claim/i);
    expect(f.inputs).toHaveLength(1);
  });
  it("rechecks the original claim after admission and immediately before native input", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    f.beforePromptGuard(() => f.changeTask({ allowAgents: false }));
    await expect(f.start(binding)).rejects.toThrow(/permission_denied/);
    expect(f.inputs).toHaveLength(0); expect(f.read().runs[0]!.admission).toBeNull();
  });
  it("rechecks the peer identity after admission and immediately before native input", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare();
    f.beforePromptGuard(() => { f.settings.peerReplaced = true; });
    await expect(f.start(binding)).rejects.toThrow(/target_changed/);
    expect(f.inputs).toHaveLength(0); expect(f.read().runs[0]!.admission).toBeNull();
  });
  it("cannot convert a failed journal commit into confirmed stopping after reopening", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const exec = Database.prototype.exec;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE") throw new Error("journal unavailable");
      return exec.call(this, sql);
    });
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/journal.*commit/i); failure.mockRestore();
    expect(f.read().runs[0]!.run.stopProof).toBeNull(); f.reopen(); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    expect(f.read().runs[0]!.phase).toBe("active");
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    expect(f.read().runs[0]!.phase).toBe("stop_unknown"); expect(f.read().runs[0]!.run.stopProof).toBeNull();
  });
  it("attempts emergency stopping if the close-request journal cannot commit", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const exec = Database.prototype.exec;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      const record = f.read();
      if (this.name.endsWith("herdr-executions.sqlite") && sql === "BEGIN IMMEDIATE" && record.runs[0]!.phase === "stop_intent" && record.ledgerRequest === null && record.publishedLedgerHash === herdrLedgerHash(record)) throw new Error("close journal unavailable");
      return exec.call(this, sql);
    });
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/close journal.*commit/i); failure.mockRestore();
    expect(f.events.filter(value => value === "stop")).toHaveLength(1);
    expect(f.read().runs[0]!.phase).toBe("stop_intent"); expect(f.read().runs[0]!.run.stopProof).toBeNull();
    f.reopen(); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it.each([false, true])("reconciles original stopping after the final stop journal commit fails, native: %s", async native => {
    const f = fixture(); f.register(); const binding = await f.prepare(); if (native) await f.start(binding);
    const original = f.read().runs[0]!;
    const exec = Database.prototype.exec;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (this.name.endsWith("herdr-executions.sqlite") && sql === "BEGIN IMMEDIATE" && f.read().runs[0]!.phase === "close_requested") throw new Error("final stop journal unavailable");
      return exec.call(this, sql);
    });
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow("final stop journal unavailable"); failure.mockRestore();
    const pending = f.read();
    expect(pending.runs[0]).toMatchObject({ phase: "close_requested", run: { stopProof: null } });
    expect(f.observed.get(original.daemon!.pid)).toBe("exited");
    f.reopen(); const recoveredEpoch = f.read().controlEpoch;
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    const stopped = f.read();
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
    expect(stopped.controlEpoch).toBe(recoveredEpoch);
    expect(stopped.runs[0]).toMatchObject({ phase: "stopped_confirmed", daemon: original.daemon, processes: original.processes, stopOperationId: pending.runs[0]!.stopOperationId });
    expect(stopped.runs[0]!.run.stopProof!.recordId).toBe(pending.runs[0]!.stopOperationId);
    expect(f.events.filter(event => event === "stop")).toHaveLength(2);
    expect(f.launches).toHaveLength(native ? 1 : 0);
  });
  it.each([false, true])("retains unknown stopping when a recovered close request observes a changed identity, native: %s", async native => {
    const f = fixture(); f.register(); const binding = await f.prepare(); if (native) await f.start(binding);
    f.mutateRecord(draft => { const run = draft.runs[0]!; run.phase = "stop_intent"; run.stopOperationId = uuid(90); run.stopReason = "shutdown"; });
    f.mutateRecord(draft => { draft.runs[0]!.phase = "close_requested"; });
    const original = f.read().runs[0]!; f.observed.set(original.daemon!.pid, "changed");
    f.reopen(); await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
    expect(f.read().runs[0]).toMatchObject({ phase: "stop_unknown", daemon: original.daemon, processes: original.processes, stopOperationId: original.stopOperationId, run: { stopProof: null } });
    expect(f.launches).toHaveLength(native ? 1 : 0);
  });
  it("recovers segment closure and ledger publication before preparing a successor", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const exec = Database.prototype.exec;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (this.name.endsWith("herdr-executions.sqlite") && sql === "BEGIN IMMEDIATE" && f.read().runs[0]!.phase === "stopped_confirmed" && f.read().segments[0]!.endedAt === null) throw new Error("segment journal unavailable");
      return exec.call(this, sql);
    });
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow("segment journal unavailable"); failure.mockRestore();
    const stoppedAt = f.read().runs[0]!.run.stoppedAt;
    expect(stoppedAt).not.toBeNull(); expect(f.read().segments[0]!.endedAt).toBeNull();
    const record = f.read();
    const source = openHerdrRecordingStore({ directory: path.join(f.paths.workerDirectory, "herdr-recordings", record.sessionId), owner: record.owner, sessionId: record.sessionId, claimId: record.claimId });
    const recordedEnd = source.recoveryBoundary(record.segments[0]!.segmentId).endedAt;
    expect(Date.parse(recordedEnd)).toBeLessThanOrEqual(Date.parse(stoppedAt!));
    f.reopen(); expect(f.facade.tasks.pendingStops()).toHaveLength(1);
    const successor = await f.prepare();
    expect(f.read().segments[0]!.endedAt).toBe(recordedEnd);
    expect(f.ledgers.some(message => message.payload.runs[0]?.stopProof !== null)).toBe(true);
    await f.start(successor);
    expect(f.read().runs).toHaveLength(2); expect(f.read().segments[0]!.endedAt).toBe(recordedEnd);
  });

});


it("registers recording responsibility before initial input and keeps capture after connection loss", async () => {
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
  expect(f.stateView().recording[0]!.responsibility?.recordingEnabled).toBe(true);
  await vi.waitFor(() => expect(f.facade.lifecycle!.archive!.resources()[0]!.sourceBytes).not.toBe("0"));
  expect(f.registrations[0]!.payload.capabilities).toEqual({ observe: true, control: true, archive: true });
  await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
  expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
});


it("retains the original active binding when recording segment allocation is exhausted", async () => {
  const maximum = SESSION_V2_LIMITS.maxSegments;
  Object.assign(SESSION_V2_LIMITS, { maxSegments: 1 });
  try {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    const segmentId = f.read().segments[0]!.segmentId;
    f.reopen();
    await f.facade.tasks.observe(f.context, binding, operation());
    expect(f.read().segments).toHaveLength(1);
    expect(f.read().segments[0]!.segmentId).toBe(segmentId);
    expect(f.read().segments[0]!.endedAt).toBeNull();
    expect(f.events.filter(value => value === "stop")).toHaveLength(0);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation());
    expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
    const record = f.read();
    const source = openHerdrRecordingStore({ directory: path.join(f.paths.workerDirectory, "herdr-recordings", record.sessionId), owner: record.owner, sessionId: record.sessionId, claimId: record.claimId }).snapshot();
    expect(source.runs[0]!.captureError).toBe("recording_limit");
    const launches = f.events.filter(value => value === "daemon-launch").length;
    await expect(f.prepare()).rejects.toThrow(/recording.*budget/i);
    expect(f.events.filter(value => value === "daemon-launch")).toHaveLength(launches);
  } finally { Object.assign(SESSION_V2_LIMITS, { maxSegments: maximum }); }
});


it("publishes a stable recovered screen after its new segment ledger is confirmed", async () => {
  const create = inputSessionModule.createHerdrInputSession, delivered = vi.fn(async () => {});
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => ({ ...create(options), publishSnapshot: delivered }));
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
  f.reopen(); delivered.mockClear();
  f.recoveryDelay(async stage => { if (stage === "state") await new Promise(resolve => setTimeout(resolve, 30)); });
  await f.facade.tasks.observe(f.context, binding, operation());
  await vi.waitFor(() => expect(delivered).toHaveBeenCalled());
  const record = f.read();
  expect(record.segments).toHaveLength(2);
  expect(record.publishedLedgerHash).toBe(herdrLedgerHash(record));
  expect(delivered.mock.calls.at(-1)).toMatchObject([record.sessionId, { segmentId: record.segments[1]!.segmentId, recorded: true }]);
});

it.each(["initial input", "ordinary observation"] as const)("publishes the enriched ledger and cached screen after native identity appears during %s without restarting", async discovery => {
  const create = inputSessionModule.createHerdrInputSession, delivered = vi.fn(async () => {});
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => ({ ...create(options), publishSnapshot: delivered }));
  const f = fixture(); f.settings.nativeAfterInput = discovery === "initial input"; f.register(); const binding = await f.prepare();
  expect(f.stateView().binding.nativeSessionId).toBeNull();
  if (discovery === "initial input") await f.start(binding);
  else await expect(f.start(binding)).rejects.toThrow();
  if (discovery === "ordinary observation") {
    expect(f.stateView().binding.nativeSessionId).toBeNull(); delivered.mockClear(); f.revealNative();
    await f.facade.tasks.observe(f.context, binding, operation());
  }
  expect(f.stateView().binding.nativeSessionId).toBe(f.nativeId);
  const record = f.read();
  expect(record.publishedLedgerHash).toBe(herdrLedgerHash(record)); expect(record.ledgerRequest).toBeNull();
  await vi.waitFor(() => expect(delivered.mock.calls.at(-1)).toMatchObject([record.sessionId, { binding: { nativeSessionId: f.nativeId }, segmentId: record.segments[0]!.segmentId, recorded: true }]));
  expect(f.launches).toHaveLength(1); expect(record.segments).toHaveLength(1); expect(f.inputs).toHaveLength(1);
});

it("reconciles an unknown enrichment publication on later observation without replaying the initial input or ledger", async () => {
  const create = inputSessionModule.createHerdrInputSession, delivered = vi.fn(async () => {});
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => ({ ...create(options), publishSnapshot: delivered }));
  const f = fixture(); f.register(); const binding = await f.prepare();
  const ledger = f.api.ledger, state = f.api.state; let unavailable = false;
  f.api.ledger = async (...args) => { const result = await ledger(...args); if (args[0].payload.runs.at(-1)!.binding.nativeSessionId !== null) { unavailable = true; throw new Error("lost enrichment response"); } return result; };
  f.api.state = (...args) => { if (unavailable) return Promise.reject(new Error("enrichment readback unavailable")); return state(...args); };
  await expect(f.start(binding)).rejects.toThrow("enrichment readback unavailable");
  const pending = f.read(); expect(pending.initialAssignment).toBe("transport_completed"); expect(pending.ledgerRequest).not.toBeNull();
  expect(pending.publishedLedgerHash).not.toBe(herdrLedgerHash(pending));
  expect(delivered.mock.calls.some(call => (call as unknown as [string, { binding: { nativeSessionId: string | null } }])[1].binding.nativeSessionId === f.nativeId)).toBe(false);
  const count = f.ledgers.length; unavailable = false;
  await f.facade.tasks.observe(f.context, binding, operation());
  expect(f.ledgers).toHaveLength(count); expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
  expect(f.read().ledgerRequest).toBeNull(); expect(f.read().publishedLedgerHash).toBe(herdrLedgerHash(f.read()));
  await vi.waitFor(() => expect(delivered.mock.calls.at(-1)).toMatchObject([pending.sessionId, { binding: { nativeSessionId: f.nativeId } }]));
});

it("keeps frames fenced when an enrichment ACK races a newer local lifecycle version", async () => {
  const create = inputSessionModule.createHerdrInputSession, delivered = vi.fn(async () => {});
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => ({ ...create(options), publishSnapshot: delivered }));
  const f = fixture(); f.register(); const binding = await f.prepare();
  const ledger = f.api.ledger;
  f.api.ledger = async (...args) => {
    const result = await ledger(...args);
    if (args[0].payload.runs.at(-1)!.binding.nativeSessionId !== null) f.mutateRecord(draft => { draft.automationBlocked = true; });
    return result;
  };
  await expect(f.start(binding)).rejects.toThrow(/changed|version|conflict/i);
  expect(f.read().ledgerRequest).not.toBeNull(); expect(f.read().publishedLedgerHash).not.toBe(herdrLedgerHash(f.read()));
  expect(delivered.mock.calls.some(call => (call as unknown as [string, { binding: { nativeSessionId: string | null } }])[1].binding.nativeSessionId === f.nativeId)).toBe(false);
  const count = f.ledgers.length;
  await f.facade.tasks.observe(f.context, binding, operation());
  expect(f.ledgers).toHaveLength(count); expect(f.inputs).toHaveLength(1); expect(f.read().automationBlocked).toBe(true);
  await vi.waitFor(() => expect(delivered.mock.calls.at(-1)).toMatchObject([f.read().sessionId, { binding: { nativeSessionId: f.nativeId } }]));
});

it("reports post-launch attachment failure until actual reattachment is published", async () => {
  const f = fixture(false, true); f.register();
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  const phases = vi.fn(), successes = vi.fn();
  const ledger = f.api.ledger, state = f.api.state;
  let unavailable = false, lost = 0;
  f.api.ledger = async (...args) => { const result = await ledger(...args); if (f.read().runs.at(-1)?.phase === "active" && lost < 2) { lost++; unavailable = true; throw new Error("lost ledger response"); } return result; };
  f.api.state = (...args) => unavailable ? Promise.reject(new Error("ledger readback unavailable")) : state(...args);
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager, herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now, observePhase: phases, observeSuccess: successes });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 3 } };
  try {
    await expect(driver.advance(input)).rejects.toThrow();
    expect(successes).toHaveBeenCalledWith(f.context, { kind: "execution", phase: "agent-start" });
    expect(phases).toHaveBeenLastCalledWith(f.context, { kind: "execution", phase: "preparing" }, false, undefined, "herdr-attachment");
    expect(successes).not.toHaveBeenCalledWith(f.context, { kind: "execution", phase: "preparing" }, "herdr-attachment");
    expect(f.inputs).toEqual([]); expect(f.launches).toHaveLength(1);
    unavailable = false;
    await expect(driver.advance(input)).rejects.toThrow("ledger readback unavailable");
    expect(successes).not.toHaveBeenCalledWith(f.context, { kind: "execution", phase: "preparing" }, "herdr-attachment");
    unavailable = false;
    const observationFailure = new Error("attachment identity observation failed");
    f.settings.observeFailure = observationFailure;
    await expect(driver.advance(input)).rejects.toBe(observationFailure);
    expect(successes).not.toHaveBeenCalledWith(f.context, { kind: "execution", phase: "preparing" }, "herdr-attachment");
    await driver.advance(input);
    expect(successes).toHaveBeenCalledWith(f.context, { kind: "execution", phase: "preparing" }, "herdr-attachment");
    expect(f.launches).toHaveLength(1);
  } finally { unavailable = false; f.api.ledger = ledger; f.api.state = state; store.close(); }
});

it("labels a durable input admission failure without changing the original error or replaying input", async () => {
  const f = fixture(false, true); f.register();
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  const phases = vi.fn(), failure = new Error("input admission failed");
  const start = f.facade.tasks.start.bind(f.facade.tasks);
  vi.spyOn(f.facade.tasks, "start").mockImplementation((context, binding, input, active) => start(context, binding, { ...input, onPromptSubmitting: () => { input.onPromptSubmitting?.(); f.failTaskRead(failure); } }, active));
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager, herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now, observePhase: phases });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 3 } };
  try {
    await expect(driver.advance(input)).rejects.toBe(failure);
    expect(phases).toHaveBeenLastCalledWith(f.context, { kind: "execution", phase: "input-submission" }, false, undefined, "startup-input");
    expect(f.inputs).toEqual([]); expect(f.launches).toHaveLength(1);
    f.failTaskRead(); await driver.advance(input); await driver.advance(input);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.launches).toHaveLength(1);
  } finally { f.failTaskRead(); store.close(); }
});

it("reports post-transport observation failure without inventing a receipt or replaying input", async () => {
  const f = fixture(false, true); f.register();
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  const phases = vi.fn(), successes = vi.fn(), submitted = vi.fn(), failure = new Error("post-transport observation failed");
  f.settings.observeAfterInputFailure = failure;
  const start = f.facade.tasks.start.bind(f.facade.tasks);
  vi.spyOn(f.facade.tasks, "start").mockImplementation((context, binding, input, active) => start(context, binding, { ...input, onPromptSubmitted: receipt => { submitted(receipt); input.onPromptSubmitted?.(receipt); } }, active));
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager, herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now, observePhase: phases, observeSuccess: successes });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 3 } };
  try {
    await expect(driver.advance(input)).rejects.toBe(failure);
    expect(phases).toHaveBeenLastCalledWith(f.context, { kind: "execution", phase: "agent-observation" }, false, undefined);
    expect(successes).toHaveBeenCalledWith(f.context, { kind: "execution", phase: "input-submission" }, "startup-input");
    expect(submitted).not.toHaveBeenCalled();
    expect(f.read().initialAssignment).toBe("transport_completed");
    await driver.advance(input); await driver.advance(input);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.launches).toHaveLength(1);
  } finally { store.close(); }
});

it("recovers a continuation at confirmed transport even when the following observation fails", async () => {
  const f = fixture(false, true); f.register();
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  const phases = vi.fn(), successes = vi.fn(), failure = new Error("continuation observation failed");
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager, herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now, observePhase: phases, observeSuccess: successes });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 3 } };
  try {
    await driver.advance(input);
    f.settings.nativeStatus = "working"; await driver.advance(input);
    f.settings.nativeStatus = "idle"; f.settings.observeFailureAfterCount = 2; f.settings.observeAfterInputFailure = failure;
    successes.mockClear();
    await expect(driver.advance(input)).rejects.toBe(failure);
    expect(phases).toHaveBeenLastCalledWith(expect.objectContaining({ claimId: task.claimId }), { kind: "execution", phase: "agent-observation" }, false, undefined);
    expect(successes).toHaveBeenCalledWith(expect.objectContaining({ claimId: task.claimId }), { kind: "execution", phase: "input-submission" });
    await driver.advance(input);
    expect(f.inputs).toHaveLength(2); expect(f.inputs[1]!.initial).toBe(false); expect(f.launches).toHaveLength(1);
  } finally { store.close(); }
});

it("does not replay the accepted assignment through the execution driver after enrichment response loss", async () => {
  const f = fixture(false, true); f.register();
  const store = openWorkerStore(f.paths.databaseFile);
  try {
    const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
    store.registerProject(project); store.registerPending({ ...f.context, agent: "codex" }); const task = store.activateTask(f.context);
    const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
    const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager,
      herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now });
    const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 3 } };
    const ledger = f.api.ledger, state = f.api.state; let unavailable = false;
    f.api.ledger = async (...args) => { const result = await ledger(...args); if (args[0].payload.runs.at(-1)!.binding.nativeSessionId !== null) { unavailable = true; throw new Error("lost enrichment response"); } return result; };
    f.api.state = (...args) => unavailable ? Promise.reject(new Error("enrichment readback unavailable")) : state(...args);
    await expect(driver.advance(input)).rejects.toThrow("enrichment readback unavailable");
    expect(f.read().initialAssignment).toBe("transport_completed"); expect(f.read().ledgerRequest).not.toBeNull();
    f.api.ledger = ledger; unavailable = false;
    await driver.advance(input);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.launches).toHaveLength(1); expect(f.read().ledgerRequest).toBeNull();
    expect(store.getTask(task)?.sessionId).toBe(f.nativeId);
  } finally { store.close(); }
});

it.each(["initial", "deferred"] as const)("keeps the %s assignment pending through paused driver advances", async kind => {
  const f = fixture(false, true); f.register();
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  const originalTask = await f.readTask();
  if (kind === "initial") f.changeTask({ properties: { ...originalTask.properties, paused: true } });
  else f.settings.nativeStatus = "blocked";
  let submitted = 0;
  const start = f.facade.tasks.start.bind(f.facade.tasks);
  vi.spyOn(f.facade.tasks, "start").mockImplementation((context, binding, input, active) => start(context, binding, { ...input, onPromptSubmitted: receipt => { submitted++; input.onPromptSubmitted?.(receipt); } }, active));
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager, herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 0 } };
  try {
    await driver.advance(input);
    if (kind === "deferred") { f.changeTask({ properties: { ...originalTask.properties, paused: true } }); f.settings.nativeStatus = "idle"; }
    const journal = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try {
      const original = f.read(), initialOperationId = journal.get(original.sessionId)!.initialOperationId;
      for (let count = 0; count < 4; count++) {
        await expect(driver.advance(input)).rejects.toMatchObject({ promptSubmission: "not-submitted" });
        expect(f.read()).toMatchObject({ initialAssignment: "pending", initialPrompt: "Original managed assignment" });
        expect(journal.get(original.sessionId)).toMatchObject({ initialOperationId, initialOutcome: "pending", unknownInput: false });
      }
      expect(submitted).toBe(0); expect(f.inputs).toEqual([]);
      f.changeTask({ properties: originalTask.properties });
      await driver.advance(input); await driver.advance(input);
      expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
      expect(f.read()).toMatchObject({ sessionId: original.sessionId, initialAssignment: "transport_completed" });
      expect(journal.get(original.sessionId)!.initialOperationId).toBe(initialOperationId);
      expect(f.launches).toHaveLength(1);
    } finally { journal.close(); }
  } finally { store.close(); }
});

it.each(["unknown", "oversized"] as const)("reattaches a fixed initial input before consulting %s prompt configuration", async latest => {
  const f = fixture(false, true); f.settings.nativeAtLaunch = true; f.settings.nativeStatus = "blocked";
  f.register(); const binding = await f.prepare();
  await expect(f.start(binding)).rejects.toMatchObject({ reason: "native_blocked", promptSubmission: "not-submitted" });
  const original = f.read(), journal = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
  const operationId = journal.get(original.sessionId)!.initialOperationId;
  journal.close(); f.reopen(); f.settings.nativeStatus = "idle";
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex", sessionId: f.nativeId }));
  const resource = (scope: "user" | "project" | "worker", text: string) => ({ scope, scopeId: scope === "project" ? project.projectId : uuid(5), text, revision: "1", updatedAt: "2026-11-09T00:00:00Z" });
  const current = vi.fn(() => latest === "unknown" ? null : { user: resource("user", "x".repeat(17_000)), project: resource("project", ""), worker: resource("worker", "") });
  const sync = vi.fn(async () => { throw new Error("A fixed input must not synchronize new prompt values"); });
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager,
    herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "New assignment must not be used",
    promptSource: { current }, preparePromptSource: sync, emit: () => {}, now: Date.now });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 0 } };
  const originalTask = await f.readTask();
  try {
    f.changeTask({ properties: { ...originalTask.properties, paused: true } });
    await expect(driver.advance(input)).rejects.toMatchObject({ reason: "task_paused", promptSubmission: "not-submitted" });
    expect(f.inputs).toEqual([]);
    f.changeTask({ properties: originalTask.properties });
    await expect(driver.advance(input)).rejects.toMatchObject({ reason: "control_suspended", promptSubmission: "not-submitted" });
    const record = f.read(), arbiter = f.facade.input!, state = arbiter.state(f.context), actorUserId = uuid(5);
    const request = { operationId: uuid(155), connectionEpoch: record.connectionEpoch!, controlEpoch: state.controlEpoch, action: "resume_automation" as const, browserClientId: uuid(101), leaseId: null, draftHandled: true, initialUnknownDisposition: null };
    const requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId, request })).digest("hex");
    const ack = await arbiter.control(f.context, { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "control_dispatch", payload: { actorUserId, requestDigest, request } }, operation());
    expect(ack.result.state).toBe("transport_completed"); f.acknowledgeControl(ack.controlState);
    await driver.advance(input); await driver.advance(input);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(f.launches).toHaveLength(1);
    expect(current).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
    const saved = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try { expect(saved.get(original.sessionId)).toMatchObject({ initialOperationId: operationId, initialOutcome: "transport_completed" }); }
    finally { saved.close(); }
  } finally { store.close(); }
});

it("does not replay a pending initial input after a human marks its uncertain outcome delivered", async () => {
  const f = fixture(false, true); f.register(); f.settings.nativeStatus = "blocked";
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager,
    herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment", emit: () => {}, now: Date.now });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 0 } };
  try {
    await driver.advance(input);
    const record = f.read(), journal = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
    try { journal.update(journal.get(record.sessionId)!, draft => { draft.initialOutcome = "unconfirmed"; draft.unknownInput = true; draft.state = "suspended"; }); }
    finally { journal.close(); }
    expect(f.facade.lifecycle!.pendingInitialPrompt!(f.context)).toBeNull();
    f.settings.nativeStatus = "idle";
    const arbiter = f.facade.input!, actorUserId = uuid(5);
    let sequence = 170;
    const control = async (action: "resolve_initial_assignment" | "resume_automation") => {
      const state = arbiter.state(f.context);
      const request = { operationId: uuid(sequence++), connectionEpoch: state.connectionEpoch, controlEpoch: state.controlEpoch, action, browserClientId: uuid(101), leaseId: null,
        draftHandled: action === "resume_automation", initialUnknownDisposition: action === "resolve_initial_assignment" ? "delivered_continue" as const : null };
      const requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId, request })).digest("hex");
      const ack = await arbiter.control(f.context, { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "control_dispatch", payload: { actorUserId, requestDigest, request } }, operation());
      expect(ack.result.state).toBe("transport_completed"); f.acknowledgeControl(ack.controlState);
    };
    await control("resolve_initial_assignment"); await control("resume_automation");
    expect(f.facade.lifecycle!.pendingInitialPrompt!(f.context)).toBeNull();
    await driver.advance(input); await driver.advance(input);
    expect(f.inputs).toEqual([]);
    expect(f.launches).toHaveLength(1);
  } finally { store.close(); }
});

it("keeps a blocked macOS recovery input fixed and respects a later task pause", async () => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const originalTask = await f.readTask();
  await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
  f.settings.nativeStatus = "blocked";
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} });
  store.registerProject(project); const task = store.activateTask(store.registerPending({ ...f.context, agent: "codex", sessionId: f.nativeId }));
  const resource = (scope: "user" | "project" | "worker", text: string, revision: string) => ({ scope, scopeId: scope === "project" ? project.projectId : uuid(5), text, revision, updatedAt: "2026-11-09T00:00:00Z" });
  let tuple = { user: resource("user", "captured", "1"), project: resource("project", "", "0"), worker: resource("worker", "", "0") };
  const submit = vi.spyOn(f.facade.tasks, "submitPrompt");
  const driver = createExecutionDriver({ store, git: { resolveWorktreeBinding: async () => worktree, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager,
    herdr: f.facade, readTask: f.readTask, platform: "macos", workerId: uuid(6), serverOrigin: "https://daynight.example", buildPrompt: () => "Original managed assignment",
    promptSource: { current: () => tuple }, emit: () => {}, now: Date.now });
  const input = { task, project, owner: f.context, title: "Original assignment", configuration: { agent: "codex" as const, model: null, args: [], recoveryLimit: 0 } };
  try {
    await driver.advance(input);
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    tuple = { ...tuple, user: resource("user", "later", "2") };
    f.settings.nativeStatus = "idle";
    f.changeTask({ properties: { ...originalTask.properties, paused: true } });
    await expect(driver.advance(input)).rejects.toMatchObject({ reason: "task_paused", promptSubmission: "not-submitted" });
    expect(submit.mock.calls.at(-1)?.[4]).toEqual(expect.any(Function));
    expect(f.inputs).toHaveLength(1);
    f.changeTask({ properties: originalTask.properties });
    await driver.advance(input); await driver.advance(input);
    expect(f.inputs).toHaveLength(2);
    expect(f.inputs[1]).toMatchObject({ initial: false });
    expect(f.inputs[1]!.body).toContain("inspect the current task, repository rules and available evidence");
    expect(f.inputs[1]!.body).toContain("no feasible alternative preserves the confirmed goal and constraints");
    expect(f.inputs[1]!.body).toContain("If allowAgents is false, stop immediately");
    expect(f.inputs[1]!.body).toContain("----- begin user prompt -----\ncaptured\n----- end user prompt -----");
    expect(f.inputs[1]!.body).not.toContain("later");
    expect(f.launches).toHaveLength(2);
  } finally { store.close(); }
});

it.each([[0, false], [0, undefined], [3, false], [3, undefined]] as const)("keeps durable patrols within recovery limit %s and resumes when paused becomes %s", async (recoveryLimit, resumed) => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const original = f.read(), originalTask = await f.readTask();
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} }); store.registerProject(project); store.activateTask(store.registerPending({ ...f.context, agent: "codex", sessionId: f.nativeId }));
  f.changeTask({ properties: { ...originalTask.properties, paused: true } });
  const remote: Pick<WorkerRemote, "currentUserId" | "ownInventory" | "candidates" | "readTask" | "update"> = {
    currentUserId: async () => uuid(5), ownInventory: async () => ({ tasks: [await f.readTask()], coveredProjectIds: [project.projectId], unavailableProjectIds: [] }), candidates: async function* () {}, readTask: f.readTask, update: f.readTask,
  };
  const git = { scanWorktrees: scanFromList, listWorktrees: async () => [{ owner: f.context, binding: worktree }], listWorktreeManifests: async () => [{ owner: f.context, binding: worktree }], resolveWorktreeBinding: async () => worktree, retireWorktreeManifest: async () => {}, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree, findWorktree: async () => worktree } as unknown as WorkerGitManager;
  const configuration = { agent: "codex" as const, model: null, args: [], recoveryLimit };
  const events: WorkerEvent[] = []; let settled = 0;
  const submit = f.facade.tasks.submitPrompt.bind(f.facade.tasks);
  vi.spyOn(f.facade.tasks, "submitPrompt").mockImplementation(async (...args) => { try { return await submit(...args); } finally { settled++; } });
  const coordinator = createWorkerCoordinator({ store, herdr: f.facade, git, remote: remote as WorkerRemote, workerId: uuid(6), serverOrigin: "https://daynight.example", platform: "macos", machine: { id: uuid(8), name: "test-machine" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false, emit: event => events.push(event), buildPrompt: () => "Original managed assignment" });
  try {
    for (let count = 1; count <= 5; count++) {
      await vi.waitFor(async () => { await coordinator.tick(); expect({ settled, errors: events.filter(event => event.kind === "execution-error").map(event => String(event.error)) }).toMatchObject({ settled: expect.any(Number), errors: [] }); expect(settled).toBeGreaterThanOrEqual(count); }, { timeout: 2000, interval: 10 });
    }
    expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
    expect(events.filter(event => event.kind === "execution-error")).toEqual([]);
    const properties = { ...originalTask.properties }; if (resumed === false) properties.paused = false;
    f.changeTask({ properties });
    await vi.waitFor(async () => { await coordinator.tick(); expect(f.inputs).toHaveLength(2); }, { timeout: 2000, interval: 10 });
    expect(f.inputs[1]).toMatchObject({ initial: false }); expect(f.inputs[1]!.body).toContain("worker's periodic check");
    expect(f.read().sessionId).toBe(original.sessionId); expect(f.read().runs).toHaveLength(1);
    expect(f.launches).toHaveLength(1); expect(events.filter(event => event.kind === "execution-error")).toEqual([]);
  } finally { await coordinator.shutdown(); store.close(); }
});

it("counts a first-frame task read failure against the coordinator recovery budget", async () => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const failure = new Error("marked task read failure");
  f.beforeFrame(index => { if (index === 0) f.failTaskRead(failure); });
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} }); store.registerProject(project); store.activateTask(store.registerPending({ ...f.context, agent: "codex", sessionId: f.nativeId }));
  const remote: Pick<WorkerRemote, "currentUserId" | "ownInventory" | "candidates" | "readTask" | "update"> = { currentUserId: async () => uuid(5), ownInventory: async () => ({ tasks: [await f.readTask()], coveredProjectIds: [project.projectId], unavailableProjectIds: [] }), candidates: async function* () {}, readTask: f.readTask, update: f.readTask };
  const git = { scanWorktrees: scanFromList, listWorktrees: async () => [{ owner: f.context, binding: worktree }], listWorktreeManifests: async () => [{ owner: f.context, binding: worktree }], resolveWorktreeBinding: async () => worktree, retireWorktreeManifest: async () => {}, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree, findWorktree: async () => worktree } as unknown as WorkerGitManager;
  const configuration = { agent: "codex" as const, model: null, args: [], recoveryLimit: 0 }, events: WorkerEvent[] = [];
  const submit = vi.spyOn(f.facade.tasks, "submitPrompt"), sync = vi.spyOn(f.facade.tasks, "syncWorkspaceName");
  const coordinator = createWorkerCoordinator({ store, herdr: f.facade, git, remote: remote as WorkerRemote, workerId: uuid(6), serverOrigin: "https://daynight.example", platform: "macos", machine: { id: uuid(8), name: "test-machine" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false, emit: event => events.push(event), buildPrompt: () => "Original managed assignment" });
  try {
    await vi.waitFor(async () => { await coordinator.tick(); expect(events.filter(event => event.kind === "execution-error")).toHaveLength(1); }, { timeout: 2000, interval: 10 });
    const error = events.find(event => event.kind === "execution-error")!.error;
    expect(error).toBeInstanceOf(HerdrAgentActionError); expect(error).not.toBeInstanceOf(HerdrInputWaitingError);
    expect(error).toMatchObject({ promptSubmission: "not-submitted", cause: failure });
    expect(f.read().runs.at(-1)?.admission).toBeNull(); expect(f.settings.nativeWrites).toBe(2);
    f.failTaskRead(); f.beforeFrame(undefined);
    const baseline = sync.mock.calls.length;
    for (let count = 1; count <= 3; count++) {
      await vi.waitFor(async () => { await coordinator.tick(); expect(sync.mock.calls.length).toBeGreaterThanOrEqual(baseline + count); }, { timeout: 2000, interval: 10 });
    }
    expect(submit).toHaveBeenCalledOnce(); expect(f.inputs).toHaveLength(1);
    await coordinator.advanceRetry(f.context);
    expect(f.inputs).toHaveLength(2); expect(submit).toHaveBeenCalledTimes(2);
  } finally { f.failTaskRead(); await coordinator.shutdown(); store.close(); }
});

it("keeps manual and suspended durable control as ordinary coordinator waits", async () => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const record = f.read(), input = f.facade.input!; let sequence = 300;
  const control = async (action: "acquire_control" | "release_control" | "resume_automation") => {
    const state = input.state(f.context), actorUserId = uuid(5);
    const request = { operationId: uuid(sequence++), connectionEpoch: record.connectionEpoch!, controlEpoch: state.controlEpoch, action, browserClientId: uuid(101), leaseId: state.lease?.leaseId ?? null, draftHandled: action === "resume_automation", initialUnknownDisposition: null };
    const requestDigest = createHash("sha256").update(canonicalSessionJson({ actorUserId, request })).digest("hex");
    const ack = await input.control(f.context, { protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: record.sessionId, claimId: record.claimId, executionGeneration: "1", agentControlMode: "herdr", contentKind: "terminal_recording", type: "control_dispatch", payload: { actorUserId, requestDigest, request } }, operation());
    expect(ack.result.state).toBe("transport_completed"); f.acknowledgeControl(ack.controlState);
  };
  await control("acquire_control");
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
  const store = openWorkerStore(f.paths.databaseFile, { onMigration: () => {} }); store.registerProject(project); store.activateTask(store.registerPending({ ...f.context, agent: "codex", sessionId: f.nativeId }));
  const remote: Pick<WorkerRemote, "currentUserId" | "ownInventory" | "candidates" | "readTask" | "update"> = { currentUserId: async () => uuid(5), ownInventory: async () => ({ tasks: [await f.readTask()], coveredProjectIds: [project.projectId], unavailableProjectIds: [] }), candidates: async function* () {}, readTask: f.readTask, update: f.readTask };
  const git = { scanWorktrees: scanFromList, listWorktrees: async () => [{ owner: f.context, binding: worktree }], listWorktreeManifests: async () => [{ owner: f.context, binding: worktree }], resolveWorktreeBinding: async () => worktree, retireWorktreeManifest: async () => {}, prepareWorktree: async () => worktree, verifyWorktree: async () => worktree, findWorktree: async () => worktree } as unknown as WorkerGitManager;
  const configuration = { agent: "codex" as const, model: null, args: [], recoveryLimit: 0 }, events: WorkerEvent[] = []; let settled = 0;
  const submit = f.facade.tasks.submitPrompt.bind(f.facade.tasks);
  vi.spyOn(f.facade.tasks, "submitPrompt").mockImplementation(async (...args) => { try { return await submit(...args); } finally { settled++; } });
  const coordinator = createWorkerCoordinator({ store, herdr: f.facade, git, remote: remote as WorkerRemote, workerId: uuid(6), serverOrigin: "https://daynight.example", platform: "macos", machine: { id: uuid(8), name: "test-machine" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false, emit: event => events.push(event), buildPrompt: () => "Original managed assignment" });
  try {
    for (let count = 1; count <= 6; count++) {
      if (count === 4) { await control("release_control"); expect(input.state(f.context).state).toBe("suspended"); }
      await vi.waitFor(async () => { await coordinator.tick(); expect(settled).toBeGreaterThanOrEqual(count); }, { timeout: 2000, interval: 10 });
      expect(events.filter(event => event.kind === "execution-error")).toEqual([]);
      expect(input.state(f.context).state).toBe(count < 4 ? "manual" : "suspended");
      expect(f.inputs).toHaveLength(1);
    }
    await control("resume_automation");
    await vi.waitFor(async () => { await coordinator.tick(); expect(f.inputs).toHaveLength(2); }, { timeout: 2000, interval: 10 });
    expect(f.read().sessionId).toBe(record.sessionId); expect(f.launches).toHaveLength(1);
    expect(events.filter(event => event.kind === "execution-error")).toEqual([]);
  } finally { await coordinator.shutdown(); store.close(); }
});


it.each([true, false])("retains crash evidence when a terminal claim stops without reattaching, recorded: %s", async recorded => {
  const f = fixture(); f.settings.recordingBlocked = !recorded;
  f.register(); const binding = await f.prepare(); await f.start(binding);
  const original = f.read(), source = () => openHerdrRecordingStore({ directory: path.join(f.paths.workerDirectory, "herdr-recordings", original.sessionId), owner: original.owner, sessionId: original.sessionId, claimId: original.claimId });
  if (recorded) await vi.waitFor(() => expect(source().status().runs[0]!.registeredFrameCount).toBe("1"));
  else expect(source().status().runs[0]!.registeredFrameCount).toBe("0");
  f.reopen(); f.changeTask({ status: "done" });
  await f.facade.lifecycle!.stop(f.context, "terminal", operation());
  expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  expect(f.read().segments).toHaveLength(1); expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
  if (recorded) {
    expect(source().metadata().gaps).toMatchObject([{ reason: "checkpoint_lost", endElapsedMs: null }]);
    const snapshot = source().snapshot(); expect(snapshot.runs[0]!.captureError).toBeNull();
    expect(BigInt(snapshot.segments[0]!.durationMs)).toBe(BigInt(snapshot.index[0]!.lastElapsedMs) + 1n);
  } else {
    expect(source).toThrow(/source_corrupt/);
    const events = readFileSync(path.join(f.paths.workerDirectory, "herdr-recordings", original.sessionId, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).event);
    expect(events).toContainEqual({ type: "error", executionGeneration: "1", code: "source_corrupt" });
    expect(events.find(event => event.type === "gap").gap).toMatchObject({ reason: "checkpoint_lost", endElapsedMs: null });
  }
});


it("releases a deleted claim with an unacknowledged stopped ledger for the next same-task claim after restart", async () => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const originalTask = await f.readTask();
  f.changeTask({ status: "done", properties: { ...originalTask.properties, worker: { ...readWorkerClaim(originalTask.properties)!, state: "completed" } } });
  f.settings.ledgerFailure = "before";
  await expect(f.facade.lifecycle!.stop(f.context, "terminal", operation())).rejects.toThrow();
  const stopped = f.read();
  expect(stopped.runs[0]!.run.stopProof).not.toBeNull(); expect(stopped.segments.every(segment => segment.endedAt !== null)).toBe(true);
  expect(stopped.publishedLedgerHash).not.toBe(herdrLedgerHash(stopped)); expect(f.facade.tasks.pendingStops()).toHaveLength(1);
  const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
  let store = openWorkerStore(f.paths.databaseFile);
  store.registerProject(project); store.activateTask(store.registerPending({ ...f.context, agent: "codex" }));
  store.saveCleanupSchedule(f.context, { deadline: Date.now() + 600000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null });
  const deleted = await f.facade.lifecycle!.archive!.dispose({ ...f.context, sessionId: stopped.sessionId, operationId: uuid(991), action: "delete", confirmed: true }, operation(), async () => { rmSync(f.context.cwd, { recursive: true }); });
  expect(reconcileDeletedHerdrResource(store, deleted)).toBe(true);
  store.close(); store = openWorkerStore(f.paths.databaseFile); f.reopen();
  const cancellation = new AbortController();
  const candidate: Task = { ...originalTask, status: "todo", ready: true, properties: { pullRequests: [] } };
  const granted: Task[] = [];
  const remote: Pick<WorkerRemote, "currentUserId" | "ownInventory" | "candidates" | "readTask" | "claim"> = {
    currentUserId: async () => uuid(5), ownInventory: async () => ({ tasks: granted, coveredProjectIds: [project.projectId], unavailableProjectIds: [] }), candidates: async function* () { yield candidate; }, readTask: f.readTask,
    claim: async (_candidate, descriptor) => {
      const task: Task = { ...originalTask, properties: { ...originalTask.properties, worker: { ...readWorkerClaim(originalTask.properties)!, ...descriptor } } };
      granted.push(task); f.changeTask(task); return task;
    },
  };
  const configuration = { agent: "codex" as const, model: null, args: [], recoveryLimit: 3 };
  const coordinator = createWorkerCoordinator({ store, herdr: f.facade, git: { scanWorktrees: scanFromList, listWorktrees: async () => [], listWorktreeManifests: async () => [], resolveWorktreeBinding: async () => null, findWorktree: async () => null } as unknown as WorkerGitManager, remote: remote as WorkerRemote,
    workerId: uuid(6), serverOrigin: "https://daynight.example", platform: "macos", machine: { id: uuid(8), name: "test-machine" }, repositories: [{ project, configuration }], globalConfiguration: configuration, maxConcurrent: 1, preferPlatformSpecificTasks: false,
    emit: () => {}, buildPrompt: () => "managed", signal: cancellation.signal, onClaim: () => cancellation.abort(new Error("Stop this test after successor admission")) });
  try {
    await coordinator.tick();
    expect(granted).toHaveLength(1);
    const next = readWorkerClaim(granted[0]!.properties)!;
    expect(next.claimId).not.toBe(f.context.claimId); expect(store.getTask({ ...f.context, claimId: next.claimId })?.status).toBe("active");
    expect(store.getTask(f.context)?.status).toBe("done"); expect(store.getCleanupSchedule(f.context)).toBeNull();
    expect(f.facade.tasks.pendingStops().some(value => value.context.claimId === f.context.claimId)).toBe(false);
    expect(f.facade.lifecycle!.responsibilities().some(value => value.claimId === f.context.claimId)).toBe(false);
    expect(f.read().publishedLedgerHash).toBe(stopped.publishedLedgerHash); expect(f.read().ledgerRequest).toEqual(stopped.ledgerRequest);
    expect(f.launches).toHaveLength(1); expect(f.events.filter(value => value === "stop")).toHaveLength(1);
  } finally { await coordinator.shutdown(); store.close(); }
});

it.each(["abandon", "delete-intent", "wrong-owner", "stop-unknown"] as const)("keeps pending stopped responsibility for %s", async failure => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const task = await f.readTask(); f.changeTask({ status: "done", properties: { ...task.properties, worker: { ...readWorkerClaim(task.properties)!, state: "completed" } } });
  f.settings.ledgerFailure = "before"; f.settings.stopUnknown = failure === "stop-unknown";
  await expect(f.facade.lifecycle!.stop(f.context, "terminal", operation())).rejects.toThrow();
  const record = f.read(), request = { ...f.context, sessionId: record.sessionId, operationId: uuid(992), action: failure === "abandon" ? "abandon" as const : "delete" as const, confirmed: true as const };
  if (failure === "wrong-owner") request.worktreeId = uuid(993);
  if (failure === "abandon") await f.facade.lifecycle!.archive!.dispose(request, operation(), async () => { throw new Error("Abandon must retain the worktree"); });
  else await expect(f.facade.lifecycle!.archive!.dispose(request, operation(), async () => { throw new Error("Deletion interrupted"); })).rejects.toThrow();
  f.reopen();
  expect(f.facade.tasks.pendingStops()).toHaveLength(1); expect(f.facade.lifecycle!.responsibilities()).toHaveLength(1);
  expect(f.facade.lifecycle!.archive!.resources()[0]!.worktreeDeleted).toBe(false);
});


it("retains pending responsibility when the completed deletion journal belongs to another owner", async () => {
  const f = fixture(false, true); f.register(); const binding = await f.prepare(); await f.start(binding);
  const task = await f.readTask(); f.changeTask({ status: "done", properties: { ...task.properties, worker: { ...readWorkerClaim(task.properties)!, state: "completed" } } });
  f.settings.ledgerFailure = "before"; await expect(f.facade.lifecycle!.stop(f.context, "terminal", operation())).rejects.toThrow();
  const record = f.read();
  await f.facade.lifecycle!.archive!.dispose({ ...f.context, sessionId: record.sessionId, operationId: uuid(994), action: "delete", confirmed: true }, operation(), async () => rmSync(f.context.cwd, { recursive: true }));
  const file = path.join(f.paths.workerDirectory, "herdr-archives", `${record.sessionId}.archive-state.json`);
  const journal = JSON.parse(readFileSync(file, "utf8")); journal.state.owner.worktreeId = uuid(995);
  journal.sha256 = createHash("sha256").update(canonicalSessionJson(journal.state)).digest("hex"); writeFileSync(file, JSON.stringify(journal));
  f.reopen();
  expect(f.facade.tasks.pendingStops()).toHaveLength(1); expect(f.facade.lifecycle!.responsibilities()).toHaveLength(1);
  expect(f.facade.lifecycle!.archive!.resources()[0]).toMatchObject({ state: "failed", worktreeDeleted: false });
});

it("retains the original live connection when service lease revocation suspends input", async () => {
  const create = inputSessionModule.createHerdrInputSession; let revoke!: () => void;
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => {
    revoke = () => options.suspend(f.context);
    return { ...create(options), connected: () => true };
  });
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
  const original = f.read(), registrations = f.registrations.length;
  revoke();
  await f.facade.tasks.observe(f.context, binding, operation());
  expect(f.registrations).toHaveLength(registrations);
  const after = f.read();
  expect(after.sessionId).toBe(original.sessionId); expect(after.connectionEpoch).toBe(original.connectionEpoch);
  expect(after.runs).toEqual(original.runs); expect(after.segments).toEqual(original.segments);
  expect(after.registrationRequest).toBeNull();
  expect(f.facade.input!.state(f.context)).toMatchObject({ state: "suspended", lease: null, availableActions: ["acquire_control", "resume_automation"] });
  await expect(f.facade.tasks.submitPrompt(f.context, binding, "Must remain suspended", operation())).rejects.toThrow();
  expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
});

it.each([false, true])("reconnects an unchanged active observation without input replay, paused: %s", async paused => {
  const create = inputSessionModule.createHerdrInputSession; let disconnect!: () => void;
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => { disconnect = () => options.suspend(f.context); return create(options); });
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
  const original = f.read(), registrations = f.registrations.length;
  disconnect();
  if (paused) { const task = await f.readTask(); f.changeTask({ properties: { ...task.properties, paused: true } }); }
  await f.facade.tasks.observe(f.context, binding, operation());
  const after = f.read();
  expect(f.registrations).toHaveLength(registrations + 1);
  expect(after.sessionId).toBe(original.sessionId); expect(after.runs).toEqual(original.runs); expect(after.segments).toEqual(original.segments);
  expect(BigInt(after.connectionEpoch!)).toBe(BigInt(original.connectionEpoch!) + 1n);
  expect(f.facade.input!.state(f.context).state).toBe("suspended");
  await expect(f.facade.tasks.submitPrompt(f.context, binding, "Must remain suspended", operation())).rejects.toThrow();
  expect(f.launches).toHaveLength(1); expect(f.inputs).toEqual([{ initial: true, body: "Original managed assignment" }]);
});

it.each(["claim", "disabled", "native"] as const)("does not reconnect unchanged observation after original %s authorization changes", async changed => {
  const create = inputSessionModule.createHerdrInputSession; let disconnect!: () => void;
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => { disconnect = () => options.suspend(f.context); return create(options); });
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding); const registrations = f.registrations.length;
  disconnect();
  if (changed === "disabled") f.changeTask({ allowAgents: false });
  else if (changed === "claim") { const task = await f.readTask(); f.changeTask({ properties: { ...task.properties, worker: { ...readWorkerClaim(task.properties)!, claimId: uuid(777) } } }); }
  else f.settings.peerReplaced = true;
  await expect(f.facade.tasks.observe(f.context, binding, operation())).rejects.toThrow(/claim|daemon/i);
  expect(f.registrations).toHaveLength(registrations); expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
});

it("reconciles a lost reconnect acknowledgement on later observation without replaying that registration", async () => {
  const create = inputSessionModule.createHerdrInputSession; let disconnect!: () => void;
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => { disconnect = () => options.suspend(f.context); return create(options); });
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
  const register = f.api.register, state = f.api.state; let unavailable = false;
  f.api.register = async (...args) => { await register(...args); unavailable = true; throw new Error("lost reconnect ACK"); };
  f.api.state = (...args) => unavailable ? Promise.reject(new Error("readback unavailable")) : state(...args);
  disconnect(); await expect(f.facade.tasks.observe(f.context, binding, operation())).rejects.toThrow("readback unavailable");
  const pending = f.read(); expect(pending.registrationRequest).not.toBeNull(); const count = f.registrations.length;
  await expect(f.facade.tasks.observe(f.context, binding, operation())).rejects.toThrow("readback unavailable");
  expect(f.registrations).toHaveLength(count); expect(f.read().registrationRequest).toEqual(pending.registrationRequest);
  unavailable = false; await f.facade.tasks.observe(f.context, binding, operation());
  expect(f.registrations).toHaveLength(count); expect(f.read().registrationRequest).toBeNull();
  expect(f.facade.input!.state(f.context).state).toBe("suspended");
  expect(f.launches).toHaveLength(1); expect(f.inputs).toHaveLength(1);
});

it("reconnects observation while preserving an unknown input result and preventing automatic input", async () => {
  const create = inputSessionModule.createHerdrInputSession; let disconnect!: () => void;
  vi.spyOn(inputSessionModule, "createHerdrInputSession").mockImplementation(options => { disconnect = () => options.suspend(f.context); return create(options); });
  const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
  f.settings.inputUnknown = true; await expect(f.facade.tasks.submitPrompt(f.context, binding, "Uncertain continuation", operation())).rejects.toThrow();
  const store = openHerdrInputStore(path.join(f.paths.workerDirectory, "herdr-inputs.sqlite"));
  try {
    const before = store.get(f.read().sessionId)!; expect(before.unknownInput).toBe(true);
    disconnect(); await f.facade.tasks.observe(f.context, binding, operation());
    const after = store.get(f.read().sessionId)!;
    expect(after.unknownInput).toBe(true); expect(after.operations).toEqual(before.operations); expect(after.state).toBe("suspended");
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Must remain blocked", operation())).rejects.toThrow();
    expect(f.inputs).toHaveLength(2); expect(f.launches).toHaveLength(1);
  } finally { store.close(); }
});


it("reads the original lifecycle worktree path without scanning archive contents", () => {
  const f = fixture(false, true); f.register();
  const resources = vi.spyOn(f.facade.lifecycle!.archive!, "resources").mockImplementation(() => { throw new Error("Archive contents must not be inspected"); });
  try {
    expect(f.facade.lifecycle!.worktreePath!(f.context)).toBe(f.context.cwd);
    expect(f.facade.lifecycle!.worktreePath!({ ...f.context, claimId: uuid(992) })).toBeNull();
    expect(() => f.facade.lifecycle!.worktreePath!({ ...f.context, worktreeId: uuid(991) })).toThrow();
    expect(resources).not.toHaveBeenCalled();
  } finally { resources.mockRestore(); }
});
