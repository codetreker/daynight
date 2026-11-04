import { createHash } from "node:crypto";
import * as inputSessionModule from "../../../src/commands/worker/herdr/input-session.js";
import { openHerdrRecordingStore } from "../../../src/commands/worker/herdr/recording-store.js";
import { SESSION_V2_LIMITS } from "../../../src/session/v2/values.js";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import { openHerdrInputStore } from "../../../src/commands/worker/herdr/input-store.js";
import { inspectHerdrInput } from "../../../src/commands/worker/herdr/input-readiness.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Task } from "../../../src/api/types.js";
import { cleanupOperation } from "../../../src/commands/cleanup-operation.js";
import { createExecutionDriver, type WorkerGitManager } from "../../../src/commands/worker/execution.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createHerdrArchiveApi } from "../../../src/commands/worker/herdr/archive-api.js";
import { createDurableWorkerHerdr } from "../../../src/commands/worker/herdr/durable.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
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
const fixture = (realInspector = false, driverResources = false) => {
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const context: HerdrExecutionContext = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4), cwd: driverResources ? path.join(directory, "repo", ".worktrees", "daynight", uuid(2)) : directory, agent: "codex" };
  mkdirSync(context.cwd, { recursive: true });
  const ownerId = uuid(5), workerId = uuid(6), nativeId = uuid(7), serverOrigin = "https://daynight.example";
  const paths: WorkerPaths = { stateDirectory: directory, workerDirectory: path.join(directory, "worker"), configFile: path.join(directory, "config.yml"), databaseFile: path.join(directory, "worker.sqlite"), lockFile: path.join(directory, "worker.lock"), herdrDirectory: path.resolve("/state/h"), logsDirectory: path.resolve("/state/logs"), temporaryDirectory: path.join(directory, "tmp") };
  let task: Task = { id: context.taskId, projectId: context.projectId, title: "Original assignment", description: "Implement the assigned feature", status: "in_progress", allowAgents: true, requiredPlatform: "macos", assignedTo: ownerId, startedAt: "2026-11-04T00:00:00Z", completedAt: null, version: 1n, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
    properties: { worker: { claimId: context.claimId, state: "active", userId: ownerId, workerId, machine: { id: uuid(8), name: "test-machine" }, platform: "macos", agent: "codex", agentControlMode: "herdr", worktreeId: context.worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-04T00:00:00Z" } } };
  const events: string[] = [], registrations: Registration[] = [], ledgers: Ledger[] = [], inputs: { initial: boolean; body: string }[] = [], launches: { resumeSessionId?: string }[] = [];
  const settings = { nativeStatus: "idle", nativeReady: true, nativeWrites: 0, nativeDraft: false, nativeAtLaunch: false, nativeAfterInput: true, inputUnknown: false, peerReplaced: false, stopUnknown: false, ledgerFailure: "none" as "none" | "before" | "after", prepareFailure: "none" as "none" | "before" | "after", recoveryFailure: "none" as "none" | "before" | "after" };
  let beforePromptGuard: (() => void) | undefined;
  let beforeLaunchRetry: (() => void) | undefined;
  let recoveryDelay: ((stage: "publish" | "state" | "prepare", signal: AbortSignal | undefined) => Promise<void>) | undefined;
  const observed = new Map<number, MacProcessObservation>();
  type Local = { ordinal: number; paths: ReturnType<typeof resolveHerdrInstancePaths>; binding: HerdrTaskBinding; started: boolean; launched: boolean; nativeVisible: boolean; daemonPid: number; shellPid: number; agentPid: number };
  const transmit = new Map<string, (initial: boolean, body: string) => Promise<unknown>>();
  const instances = new Map<string, Local>(); let sequence = 0, reader: HerdrLifecycleStore | undefined, facade: WorkerHerdrAdapter;
  const read = () => {
    reader ??= openHerdrLifecycleStore(path.join(paths.workerDirectory, "herdr-executions.sqlite"), { onMigration: () => {} }); readers.add(reader);
    const record = reader.get(context); if (!record) throw new Error("Missing test execution"); return record;
  };
  const proof = (pid: number, role: MacProcessIdentity["role"]): MacProcessIdentity => {
    const local = [...instances.values()].find(value => [value.daemonPid, value.shellPid, value.agentPid].includes(pid));
    if (!local) throw new Error("Unexpected process identity");
    return { pid, role, birthToken: `1700000000:${pid}`, bootId: "boot-one", auditToken: [501, 501, 20, 501, 20, pid, 100000, pid + 100], ppid: role === "daemon" ? 1 : role === "shell" ? local.daemonPid : local.shellPid, pgid: pid, sid: role === "daemon" ? pid : local.shellPid };
  };
  const native: MacProcessControl = {
    bootIdentity: async () => "boot-one",
    capture: async (pid, role) => { events.push(`capture:${role}`); return proof(pid, role); },
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
    let local = instances.get(options.paths.herdrDirectory);
    if (!local) { const ordinal = ++sequence; local = { ordinal, paths: resolveHerdrInstancePaths(options.paths), binding: { session: "w", workspaceId: `workspace-${ordinal}`, paneId: `pane-${ordinal}`, terminalId: `terminal-${ordinal}` }, started: false, launched: false, nativeVisible: false, daemonPid: ordinal * 100, shellPid: ordinal * 100 + 1, agentPid: ordinal * 100 + 2 }; instances.set(options.paths.herdrDirectory, local); }
    const state = local;
    const observation = (): HerdrAgentObservation => ({ binding: state.binding, kind: state.launched ? "codex" : null, name: null, status: settings.nativeStatus, launchPending: false, interactiveReady: state.launched && settings.nativeReady, nativeSession: state.nativeVisible ? { source: "herdr:codex", agent: "codex", sessionId: nativeId } : null, stateChangeSeq: 1, completionSeq: 0 });
    const input = async (initial: boolean, body: string) => {
      const record = read(), run = record.runs.at(-1)!;
      expect(run.phase).toBe("active"); expect(run.daemon).toEqual(proof(state.daemonPid, "daemon"));
      expect(run.processes).toEqual([proof(state.shellPid, "shell"), proof(state.agentPid, "agent")]); expect(run.admission).not.toBeNull();
      expect(initial ? ["dispatching"] : ["transport_completed", "unknown"]).toContain(record.initialAssignment);
      events.push(initial ? "initial-input" : "continuation-input"); inputs.push({ initial, body });
      if (settings.inputUnknown) throw new HerdrAgentActionError("Lost input receipt", "agent.prompt", "unknown", { promptSubmission: "unknown" });
      state.nativeVisible = settings.nativeAfterInput;
      return { submission: "submitted" as const, observation: observation() };
    };
    transmit.set(state.paths.clientEndpoint, input);
    return {
      paths: state.paths, attachment: { executable: "herdr", arguments: [], environment: {}, unsetEnvironment: [] },
      ensureInstance: async () => { if (!state.started) { events.push("daemon-launch"); expect(read().preparation?.phase).toBe("launch_requested"); await options.onDaemonSpawn?.(state.daemonPid); state.started = true; } return { reconnected: false, version: "0.9.5", protocol: 22, snapshot: {} }; },
      stopInstance: async () => { throw new Error("Unsafe daemon close must not be used"); },
      tasks: {
        pendingStops: () => [], listResources: async () => driverResources && state.launched ? [{ owner: context, workspaceId: state.binding.workspaceId, panes: [{ ...observation(), kind: "codex" as const, cwd: context.cwd }] }] : [],
        prepareWorkspace: async () => { events.push("workspace"); return state.binding; },
        syncWorkspaceName: async () => {}, observe: async () => observation(),
        processInfo: async () => ({ shellPid: state.shellPid, foregroundPids: state.launched ? [state.agentPid] : [state.shellPid] }),
        launch: async (_context, _binding, request, active) => {
          await request.beforeStart?.(active);
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
    facade = createDurableWorkerHerdr({ paths, homeDirectory: directory, serverOrigin, serverToken: "fixture-token", workerId, readTask: async () => task, processControl: native,
      readRecording: async () => ({ width: 1, height: 1, rows: [[]] }), currentUserId: async () => ownerId,
      archiveApi: { ...createHerdrArchiveApi(serverOrigin, "fixture-token"), state: async () => stateView(), recording: async (_expected, message) => {
        const m = message as SessionV2Message;
        if (m.type !== "recording_responsibility" || !remote) throw new Error("Unexpected recording fixture message");
        remote.recording.push({ executionGeneration: m.executionGeneration, responsibility: m.payload, evidence: null }); return message;
      } },
      inspectInput: async request => {
        if (realInspector) return inspectHerdrInput({ ...request, readSize: async () => ({ width: 100, height: 24 }), rpc: { request: async method => {
          const local = [...instances.values()].find(value => value.binding.terminalId === request.binding.terminalId)!;
          const binding = local.binding;
          if (method === "ping") return { type: "pong", version: "0.9.5" };
          if (method === "session.snapshot") return { type: "session_snapshot", snapshot: { panes: [{ pane_id: binding.paneId, terminal_id: binding.terminalId, workspace_id: binding.workspaceId, tab_id: "tab" }] } };
          if (method === "pane.process_info") return { type: "pane_process_info", process_info: { pane_id: binding.paneId, shell_pid: local.shellPid, tty: "/dev/ttys001" } };
          if (method === "pane.read") return { type: "pane_read", read: { pane_id: binding.paneId, workspace_id: binding.workspaceId, tab_id: "tab", source: "visible", format: "text", truncated: false, text: settings.nativeDraft ? "› a pending draft" : "› Ask Codex to do anything\n gpt · /tmp/project" } };
          throw new Error(`Unexpected readiness RPC: ${method}`);
        } } });
        if (request.purpose !== "manual" && settings.nativeDraft) throw new Error("The native composer now contains this batch's paste");
        return { width: 100, height: 24, herdrVersion: "0.9.5", composer: "empty" };
      },
      submitInput: async request => {
        beforePromptGuard?.();
        let written = false;
        try {
          for (const part of request.inputs) {
            await request.beforeWrite(); request.onWrite?.(); written = true;
            settings.nativeWrites += 1;
            settings.nativeDraft = part.kind === "paste";
          }
        } catch (error) { return { status: written ? "unknown" : "rejected", reason: String(error) }; }
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
  return { context, paths, events, registrations, ledgers, inputs, launches, settings, observed, nativeId, api, read, stateView, register, prepare, start, reopen, readTask: async () => task,
    revealNative: () => { for (const local of instances.values()) if (local.launched) local.nativeVisible = true; },
    mutateRecord: (change: Parameters<HerdrLifecycleStore["update"]>[1]) => { const record = read(); return reader!.update(record, change); },
    get facade() { return facade; }, adjustControlRead: (hook: NonNullable<typeof adjustControlRead>) => { adjustControlRead = hook; }, recoveryDelay: (hook: NonNullable<typeof recoveryDelay>) => { recoveryDelay = hook; }, beforePromptGuard: (hook: () => void) => { beforePromptGuard = hook; }, beforeLaunchRetry: (hook: () => void) => { beforeLaunchRetry = hook; }, changeTask: (value: Partial<Task>) => { task = { ...task, ...value }; } };
};

describe("durable Herdr facade with real SQLite", () => {
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
    f.settings.nativeReady = true; f.settings.nativeDraft = true;
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Conflicting draft", operation())).rejects.toThrow(/automation_suspended/);
    expect(f.settings.nativeWrites).toBe(4);
    f.settings.nativeDraft = false;
    f.observed.set(f.read().runs[0]!.processes.find(value => value.role === "shell")!.pid, "changed");
    await expect(f.facade.tasks.submitPrompt(f.context, binding, "Replaced process", operation())).rejects.toThrow(/changed/);
    expect(f.settings.nativeWrites).toBe(4);
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
    expect(await f.facade.lifecycle!.cleanup!(f.context, "Cleanup now", operation())).toBe(false);
    expect(f.inputs).toHaveLength(1); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(true);
  });
  it("sends eligible cleanup through the same input journal before controlled stop", async () => {
    const f = fixture(); f.register(); const binding = await f.prepare(); await f.start(binding);
    expect(await f.facade.lifecycle!.cleanup!(f.context, "Cleanup now", operation())).toBe(true);
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
    const f = fixture(); f.settings.nativeAfterInput = false; f.register(); const binding = await f.prepare(); await f.start(binding);
    await f.facade.lifecycle!.stop(f.context, "shutdown", operation()); f.reopen();
    await expect(f.prepare()).rejects.toThrow(/native.*identity|native.*session/i); expect(f.launches).toHaveLength(1);
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
  it("keeps missing native launch proof unknown even when remaining resources stop", async () => {
    const f = fixture(); f.register(); await f.prepare();
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow(/stop_unknown/i);
    expect(f.read().runs[0]!.phase).toBe("stop_unknown"); expect(f.read().runs[0]!.run.stopProof).toBeNull(); expect(f.inputs).toHaveLength(0);
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
  await f.start(binding);
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

it("does not replay the accepted assignment through the execution driver after enrichment response loss", async () => {
  const f = fixture(false, true); f.register();
  const store = openWorkerStore(f.paths.databaseFile);
  try {
    const project = { projectId: f.context.projectId, repoUrl: "https://example.test/repo.git", localPath: path.resolve(f.context.cwd, "../../..") };
    store.registerProject(project); store.registerPending({ ...f.context, agent: "codex" }); const task = store.activateTask(f.context);
    const worktree = { repositoryPath: project.localPath, commonDirectory: path.join(project.localPath, ".git"), worktreePath: f.context.cwd, branch: `daynight/${f.context.taskId}` };
    const driver = createExecutionDriver({ store, git: { prepareWorktree: async () => worktree, verifyWorktree: async () => worktree } as unknown as WorkerGitManager,
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
