import { createHash } from "node:crypto";
import { canonicalSessionJson } from "../../../src/session/v2/values.js";
import { openHerdrInputStore } from "../../../src/commands/worker/herdr/input-store.js";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import type { Task } from "../../../src/api/types.js";
import { cleanupOperation } from "../../../src/commands/cleanup-operation.js";
import { createDurableWorkerHerdr } from "../../../src/commands/worker/herdr/durable.js";
import { HerdrAgentActionError } from "../../../src/commands/worker/herdr.js";
import type { createWorkerHerdr, HerdrAgentObservation, HerdrExecutionContext, HerdrTaskBinding, WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import { resolveHerdrInstancePaths } from "../../../src/commands/worker/herdr/instance.js";
import { openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { HerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import type { MacProcessIdentity } from "../../../src/commands/worker/herdr/lifecycle-types.js";
import type { MacProcessControl, MacProcessObservation } from "../../../src/commands/worker/herdr/native-macos.js";
import type { HerdrSessionApi, HerdrSessionState } from "../../../src/commands/worker/herdr/session-api.js";
import type { WorkerPaths } from "../../../src/commands/worker/paths.js";
import type { SessionV2Message } from "../../../src/session/v2/types.js";

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
const fixture = () => {
  mkdirSync(root, { recursive: true }); const directory = mkdtempSync(path.join(root, "run-")); directories.push(directory);
  const context: HerdrExecutionContext = { projectId: uuid(1), taskId: uuid(2), claimId: uuid(3), worktreeId: uuid(4), cwd: directory, agent: "codex" };
  const ownerId = uuid(5), workerId = uuid(6), nativeId = uuid(7), serverOrigin = "https://daynight.example";
  const paths: WorkerPaths = { stateDirectory: directory, workerDirectory: path.join(directory, "worker"), configFile: path.join(directory, "config.yml"), databaseFile: path.join(directory, "worker.sqlite"), lockFile: path.join(directory, "worker.lock"), herdrDirectory: path.resolve("/state/h"), logsDirectory: path.resolve("/state/logs"), temporaryDirectory: path.join(directory, "tmp") };
  let task: Task = { id: context.taskId, projectId: context.projectId, title: "Original assignment", description: "Implement the assigned feature", status: "in_progress", allowAgents: true, requiredPlatform: "macos", assignedTo: ownerId, startedAt: "2026-11-04T00:00:00Z", completedAt: null, version: 1n, createdAt: "2026-11-04T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z", dependsOn: [], externalDependsOn: [], blockedBy: [], ready: false,
    properties: { worker: { claimId: context.claimId, state: "active", userId: ownerId, workerId, machine: { id: uuid(8), name: "test-machine" }, platform: "macos", agent: "codex", agentControlMode: "herdr", worktreeId: context.worktreeId, phase: "executing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-04T00:00:00Z" } } };
  const events: string[] = [], registrations: Registration[] = [], ledgers: Ledger[] = [], inputs: { initial: boolean; body: string }[] = [], launches: { resumeSessionId?: string }[] = [];
  const settings = { nativeDraft: false, nativeAfterInput: true, inputUnknown: false, peerReplaced: false, stopUnknown: false };
  let beforePromptGuard: (() => void) | undefined;
  let beforeLaunchRetry: (() => void) | undefined;
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
    stopExclusiveRun: async input => {
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
  const api: HerdrSessionApi = {
    verifySupport: async () => { events.push("support"); },
    current: async expected => remote ? structuredClone(remote) : { status: "not_registered", protocol: "daynight.session.v2", claimId: expected.claimId, agentControlMode: "herdr" },
    register: async request => {
      registrations.push(structuredClone(request)); events.push(`register:${request.payload.mode}`);
      const connectionEpoch = request.payload.connectionEpoch === null ? "1" : String(BigInt(request.payload.connectionEpoch) + 1n);
      remote = { status: "registered", protocol: "daynight.session.v2", schemaVersion: 2, projectionVersion: 1, sessionId: request.sessionId, claimId: request.claimId, executionGeneration: request.executionGeneration, agentControlMode: "herdr", contentKind: "terminal_recording", owner: structuredClone(request.payload.owner), binding: structuredClone(request.payload.binding), connectionEpoch, connected: true, capabilities: { observe: false, control: false, archive: false }, control: null, snapshot: null, ledger: remote?.ledger ?? { runs: [], finalizationId: null }, archive: { state: "pending", sha256: null, byteLength: null, completeness: null, errorCode: null, finalizationId: null }, recording: [] };
      return { ...request, type: "registration_ack", payload: { registrationId: request.payload.registrationId, connectionEpoch } };
    },
    ledger: async (request, epoch) => {
      if (!remote || remote.connectionEpoch !== epoch) throw new Error("Unregistered or stale connection");
      ledgers.push(structuredClone(request)); events.push(`ledger:${request.executionGeneration}`);
      remote = { ...remote, executionGeneration: request.executionGeneration, binding: structuredClone(request.payload.runs.at(-1)!.binding), ledger: structuredClone(request.payload) };
      return request;
    },
    state: async () => {
      if (!remote) throw new Error("No remote state");
      return structuredClone(remote);
    },
  };
  const createAdapter: typeof createWorkerHerdr = options => {
    let local = instances.get(options.paths.herdrDirectory);
    if (!local) { const ordinal = ++sequence; local = { ordinal, paths: resolveHerdrInstancePaths(options.paths), binding: { session: "w", workspaceId: `workspace-${ordinal}`, paneId: `pane-${ordinal}`, terminalId: `terminal-${ordinal}` }, started: false, launched: false, nativeVisible: false, daemonPid: ordinal * 100, shellPid: ordinal * 100 + 1, agentPid: ordinal * 100 + 2 }; instances.set(options.paths.herdrDirectory, local); }
    const state = local;
    const observation = (): HerdrAgentObservation => ({ binding: state.binding, kind: state.launched ? "codex" : null, name: null, status: "idle", launchPending: false, interactiveReady: state.launched, nativeSession: state.nativeVisible ? { source: "herdr:codex", agent: "codex", sessionId: nativeId } : null, stateChangeSeq: 1, completionSeq: 0 });
    const input = async (initial: boolean, body: string) => {
      const record = read(), run = record.runs.at(-1)!;
      expect(run.phase).toBe("active"); expect(run.daemon).toEqual(proof(state.daemonPid, "daemon"));
      expect(run.processes).toEqual([proof(state.shellPid, "shell"), proof(state.agentPid, "agent")]); expect(run.admission).not.toBeNull();
      expect(record.initialAssignment).toBe(initial ? "dispatching" : "transport_completed");
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
        pendingStops: () => [], listResources: async () => [],
        prepareWorkspace: async () => { events.push("workspace"); return state.binding; },
        syncWorkspaceName: async () => {}, observe: async () => observation(),
        processInfo: async () => ({ shellPid: state.shellPid, foregroundPids: state.launched ? [state.agentPid] : [state.shellPid] }),
        launch: async (_context, _binding, request, active) => {
          await request.beforeStart?.(active);
          if (beforeLaunchRetry) { events.push("native-busy-attempt"); beforeLaunchRetry(); await request.beforeStart?.(active); }
          expect(read().runs.at(-1)?.phase).toBe("launch_requested"); events.push("native-launch"); launches.push(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}); state.launched = true; state.nativeVisible = request.resumeSessionId !== undefined; return observation(); },
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
      inspectInput: async request => {
        if (request.purpose !== "manual" && settings.nativeDraft) throw new Error("The native composer now contains this batch's paste");
        return { width: 100, height: 24, herdrVersion: "0.9.5", composer: "empty" };
      },
      submitInput: async request => {
        beforePromptGuard?.();
        let written = false;
        try {
          for (const part of request.inputs) {
            await request.beforeWrite(); request.onWrite?.(); written = true;
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
  return { context, paths, events, registrations, ledgers, inputs, launches, settings, observed, nativeId, read, register, prepare, start, reopen, get facade() { return facade; }, beforePromptGuard: (hook: () => void) => { beforePromptGuard = hook; }, beforeLaunchRetry: (hook: () => void) => { beforeLaunchRetry = hook; }, changeTask: (value: Partial<Task>) => { task = { ...task, ...value }; } };
};

describe("durable Herdr facade with real SQLite", () => {
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
    expect(f.read().runs[0]!.phase).toBe("stopped_confirmed"); expect(f.facade.lifecycle!.isStopped(f.context)).toBe(false);
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
    expect(f.registrations[0]!.payload.capabilities).toEqual({ observe: false, control: false, archive: false });
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
    const exec = Database.prototype.exec; let transactions = 0;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (this.name.endsWith("herdr-executions.sqlite") && sql === "BEGIN IMMEDIATE" && ++transactions === 2) throw new Error("close journal unavailable");
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
    const exec = Database.prototype.exec; let transactions = 0;
    const failure = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (this.name.endsWith("herdr-executions.sqlite") && sql === "BEGIN IMMEDIATE" && ++transactions === 4) throw new Error("segment journal unavailable");
      return exec.call(this, sql);
    });
    await expect(f.facade.lifecycle!.stop(f.context, "shutdown", operation())).rejects.toThrow("segment journal unavailable"); failure.mockRestore();
    const stoppedAt = f.read().runs[0]!.run.stoppedAt;
    expect(stoppedAt).not.toBeNull(); expect(f.read().segments[0]!.endedAt).toBeNull();
    f.reopen(); expect(f.facade.tasks.pendingStops()).toHaveLength(1);
    const successor = await f.prepare();
    expect(f.read().segments[0]!.endedAt).toBe(stoppedAt);
    expect(f.ledgers.some(message => message.payload.runs[0]?.stopProof !== null)).toBe(true);
    await f.start(successor);
    expect(f.read().runs).toHaveLength(2); expect(f.read().segments[0]!.endedAt).toBe(stoppedAt);
  });

});
