import { controllerJournalFormat } from "../../../src/commands/controller/journal-format.js";
import { currentSqliteVersion } from "../../../src/platform/sqlite-format.js";
import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import path from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import * as localClient from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, controllerPayloadHash, controllerTicketPath, writeLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
import { createWebExecutionBackend } from "../../../src/commands/worker/backends/web.js";
import type { LocalTask } from "../../../src/commands/worker/backends/web-types.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import type { Task } from "../../../src/api/types.js";

const { orchestrationFixture } = createWebBackendFixtures("file");

const liveJournal = async (recoveryLimit = 3, windowsBoundary = false) => {
  const f = await orchestrationFixture(recoveryLimit);
  if (windowsBoundary) {
    f.snapshot.controllerProcess = { ...f.snapshot.controllerProcess!, jobObjectName: `Local\\Daynight-${f.source.ticket.launchId}` };
    f.task = f.store.updateWebExecution(f.task, { controllerProcess: f.snapshot.controllerProcess }, 7);
  }
  f.launcher.prepare.mockResolvedValue(f.source.ticket);
  f.source.saved.mockRestore();
  vi.mocked(lifecycle.readCompatibleControllerSnapshot).mockRestore();
  const file = path.join(controllerExecutionDirectory(f.home, f.source.ticket.executionId), "journal.sqlite");
  const journal = lifecycle.openControllerLifecycleStore(file, f.source.ticket, { onMigration: () => {} });
  try { journal.patchSnapshot({ lifecycle: f.snapshot.lifecycle, activity: f.snapshot.activity, initialInputState: f.snapshot.initialInputState,
    nativeSessionId: f.snapshot.nativeSessionId, controllerProcess: f.snapshot.controllerProcess, nativeProcesses: f.snapshot.nativeProcesses,
    nativeStopped: f.snapshot.nativeStopped, stoppedAt: f.snapshot.stoppedAt, startup: f.snapshot.startup!, capabilities: f.snapshot.capabilities }); }
  finally { journal.close(); }
  const db = new Database(file);
  try {
    restoreControllerJournalVersion(db, 16);
    db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid);
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    expect(db.prepare("SELECT owner_pid FROM execution WHERE id=1").get()).toEqual({ owner_pid: process.pid });
  }
  finally { db.close(); }
  const bytes = readFileSync(file);
  return { ...f, file, bytes };
};

it("rejects both reads of a live v16 journal without changing its bytes", async () => {
  const f = await liveJournal();
  let failure: unknown;
  try { lifecycle.readControllerSnapshot(f.file); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ kind: "upgrade-blocked", cause: { kind: "upgrade-blocked", context: { phase: "owner-admission" } } });
  expect(readFileSync(f.file)).toEqual(f.bytes);
  expect(() => lifecycle.readCurrentControllerSnapshot(f.file, f.source.ticket)).toThrow(/current journal format/);
  expect(readFileSync(f.file)).toEqual(f.bytes);
});

it("stops a live v16 boundary while the original cancelled Task writer remains unjoined", async () => {
  const f = await liveJournal(), store = openWorkerStore(createMemoryDatabase()), root = new AbortController();
  const project = { projectId: f.task.projectId, repoUrl: f.identity.repoUrl, localPath: f.home };
  store.registerProject(project);
  const local = store.activateTask(store.registerPending({ ...f.identity, agent: "codex", agentControlMode: "web" }));
  const task = { id: f.task.taskId, projectId: f.task.projectId, status: "in_progress", allowAgents: true, properties: { worker: {
    claimId: f.task.claimId, worktreeId: f.task.worktreeId, state: "active", userId: f.task.userId, workerId: f.task.workerId,
    machine: { id: f.task.workerId, name: "fixture" }, platform: "windows", agent: "codex", agentControlMode: "web", phase: "executing", herdr: null,
    nativeSessionId: f.task.resources.nativeSession!.sessionId, claimedAt: new Date().toISOString(),
  } } } as unknown as Task;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const cleanup = vi.fn(async () => ({ task: f.task, complete: true }));
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue();
  const { advanceResult: _advanceResult, ...backend } = f.backend;
  const coordinator = createWorkerCoordinator({ store, webStore: f.store, signal: root.signal, serverOrigin: f.task.serverOrigin,
    workerId: f.task.workerId, userId: f.task.userId!, platform: "windows", machine: { id: f.task.workerId, name: "fixture" },
    repositories: [{ project, configuration: f.task.configuration! }], globalConfiguration: f.task.configuration!, maxConcurrent: 1,
    platformTaskMode: "all", git: f.git, remote: { currentUserId: async () => f.task.userId!, readTask: async () => task } as never,
    webBackend: { ...backend, cleanup, advance: async () => { entered(); await gate; return f.task; } }, emit: vi.fn() });
  const writer = coordinator.advanceRetry(f.task).catch(error => error);
  try {
    await Promise.race([started, writer.then(error => { throw error ?? new Error("Task writer did not enter its backend."); })]);
    const before = f.store.getTask(f.task);
    expect(await coordinator.shutdown({ deadline: Date.now() + 500 })).toBe(false);
    expect(stop).toHaveBeenCalledWith(f.snapshot.controllerProcess, f.snapshot.nativeProcesses, expect.any(Number));
    expect(cleanup).not.toHaveBeenCalled();
    expect(coordinator.executionSnapshot().taskWriters).toEqual([`${f.task.projectId}/${f.task.taskId}`]);
    expect(f.store.getTask(f.task)).toEqual(before); expect(store.getTask(f.task)).toEqual(local);
    expect(readFileSync(f.file)).toEqual(f.bytes);
  } finally { release(); await writer; await coordinator.shutdown(); store.close(); }
});

it.each([0, 3])("ordinarily restarts a healthy exhausted v16 execution after shutdown (limit=%s)", async limit => {
  const f = await liveJournal(limit, true);
  let task = f.task;
  for (let count = 0; count < limit; count++) task = f.store.beginRecovery(task, 8 + count);
  const recovery = task.recovery;
  vi.mocked(lifecycle.recordStoppedControllerGeneration).mockRestore();
  vi.mocked(launchObservation.reconcileSubmittedControllerLaunch).mockRestore();
  vi.spyOn(localClient, "requestController").mockRejectedValue(new localClient.ControllerIpcOutcomeUnknownError("The original Controller exited."));
  vi.spyOn(processProof, "inspectBootstrapProcessProof").mockResolvedValue("stopped");
  let stopped = false;
  f.source.stopped.mockImplementation(async () => stopped);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockImplementation(async () => {
    expect(readFileSync(f.file)).toEqual(f.bytes);
    stopped = true;
    const db = new Database(f.file);
    try { db.prepare("UPDATE execution SET owner_pid=NULL WHERE id=1").run(); }
    finally { db.close(); }
  });
  const lease = {} as import("../../../src/commands/controller/windows-job.js").ControllerJobLease;
  const leases = { enabled: true, retainBirthCleanup: () => () => {}, cleanupBirth: async () => {}, adopt: () => { throw new Error("Unexpected native launch."); },
    retain: vi.fn(async () => lease), get: vi.fn(async () => lease), release: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  f.launcher.prepare.mockImplementation(async (record: LocalTask) => {
    const execution = record.webExecution!;
    const ticket = { ...f.source.ticket, launchId: execution.launchId, executionGeneration: execution.executionGeneration, controllerInstanceId: execution.controllerInstanceId };
    await writeLaunchTicket(f.home, ticket);
    return ticket;
  });
  f.launcher.launch.mockImplementation(async (record: LocalTask) => {
    if (record.webExecution!.executionGeneration === "2") f.store.updateWebExecution(record, { launchSubmission: "acknowledged", controllerProcess: {
      ...f.snapshot.controllerProcess!, pid: 989, jobObjectName: `Local\\Daynight-${record.webExecution!.launchId}`,
    } }, 60_000);
  });
  f.source.request.mockImplementation(async (ticket, action) => {
    if (ticket.executionGeneration === "1" && stopped) throw new localClient.ControllerIpcOutcomeUnknownError("The original Controller exited.");
    const snapshot = ticket.executionGeneration === "1" ? f.snapshot : { ...f.snapshot, executionGeneration: ticket.executionGeneration,
      controllerInstanceId: ticket.controllerInstanceId, controllerProcess: f.store.getTask(f.task)!.webExecution!.controllerProcess, nativeProcesses: [] };
    return { requestId: ticket.launchId, ok: true, snapshot };
  });
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: f.launcher, jobLeases: leases,
    platform: "windows", buildPrompt: () => "managed", emit: vi.fn(), now: () => 50_000, request: f.source.request });
  const shutdown = await backend.cleanup(task, { kind: "shutdown", deadline: 50_000, immediateStop: true });
  expect(shutdown.complete).toBe(true); expect(shutdown.task.recovery).toEqual(recovery);
  expect(stop).toHaveBeenCalledOnce(); expect(leases.release).toHaveBeenCalledWith(f.source.ticket.launchId);
  expect(lifecycle.readCurrentControllerSnapshot(f.file, f.source.ticket)).toMatchObject({ lifecycle: "stopped", nativeStopped: true });
  const restored = f.store.clearShutdown(shutdown.task, 50_001);
  const resumed = await backend.advance(restored, new AbortController().signal);
  expect(resumed.recovery).toEqual(recovery);
  expect(resumed.webExecution).toMatchObject({ executionGeneration: "2", restartAfterShutdown: false });
  expect(resumed.resources.nativeSession).toEqual(task.resources.nativeSession);
  expect(f.launcher.launch.mock.calls.filter(([record]) => record.webExecution!.executionGeneration === "2")).toHaveLength(1);
});

it("keeps the original live v16 writer and graceful cleanup receipt pending until its fixed deadline", async () => {
  const f = await liveJournal();
  f.source.stopped.mockResolvedValue(false);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue();
  f.source.request.mockImplementation(async (ticket, action) => {
    if (action.kind === "cleanup") {
      const payload = { prompt: action.prompt, deadline: action.deadline };
      const operation = { operationId: action.operationId, executionGeneration: ticket.executionGeneration, kind: "cleanup", payload,
        payloadHash: controllerPayloadHash({ kind: "cleanup", payload }), state: "accepted", result: null, error: null, createdAt: 50_000, updatedAt: 50_000 };
      const db = new Database(f.file);
      try { db.prepare("INSERT INTO operations(id,value,acknowledged) VALUES(?,?,0)").run(operation.operationId, JSON.stringify(operation)); }
      finally { db.close(); }
    }
    return { requestId: ticket.launchId, ok: true, snapshot: f.snapshot };
  });
  const request = { kind: "terminal" as const, deadline: 100_000, immediateStop: false,
    scope: { attempt: { attemptId: f.source.ticket.launchId, owner: f.task }, onExecutionStopped: vi.fn() } };
  const first = await f.backend.cleanup(f.task, request);
  expect(first.complete).toBe(false);
  const bytes = readFileSync(f.file);
  expect((await f.backend.cleanup(first.task, request)).complete).toBe(false);
  expect(readFileSync(f.file)).toEqual(bytes);
  expect(first.task.cleanup).toMatchObject({ kind: "terminal", deadline: 100_000 });
  expect(f.source.request.mock.calls.filter(([, action]) => action.kind === "cleanup")).toHaveLength(1);
  expect(stop).not.toHaveBeenCalled(); expect(f.git.removeWorktree).not.toHaveBeenCalled();
  const db = new Database(f.file, { readonly: true });
  try { expect(db.pragma("user_version", { simple: true })).toBe(16); expect(db.prepare("SELECT owner_pid FROM execution WHERE id=1").get()).toEqual({ owner_pid: process.pid }); }
  finally { db.close(); }
});

it.each(["accepted", "confirmed", "payload-conflict", "generation-conflict", "ticket-conflict", "future"] as const)("reconciles an original live v16 automatic input receipt (%s)", async state => {
  const f = await liveJournal();
  const snapshot = { ...f.snapshot, lifecycle: "ready" as const, activity: "idle" as const, initialInputState: "unknown" as const,
    capabilities: { ...f.snapshot.capabilities, send: true } };
  const payload = { text: f.source.ticket.initialPrompt }, operation = { operationId: f.source.ticket.initialOperationId,
    executionGeneration: state === "generation-conflict" ? "2" : f.source.ticket.executionGeneration, kind: "initial", payload,
    payloadHash: state === "payload-conflict" ? "b".repeat(64) : controllerPayloadHash({ kind: "initial", payload }),
    state: state === "accepted" ? "accepted" : "confirmed", result: null, error: null, createdAt: 0, updatedAt: 0 };
  const db = new Database(f.file);
  try {
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot));
    db.prepare("INSERT INTO operations(id,value,acknowledged) VALUES(?,?,0)").run(operation.operationId, JSON.stringify(operation));
    if (state === "ticket-conflict") db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("b".repeat(64));
    if (state === "future") db.pragma(`user_version=${currentSqliteVersion(controllerJournalFormat) + 1}`);
  } finally { db.close(); }
  const bytes = readFileSync(f.file);
  const task = f.store.updateWebExecution(f.task, { initialInputState: "unknown", activity: "idle" }, 8);
  f.source.request.mockResolvedValue({ requestId: f.source.ticket.launchId, ok: true, snapshot, workerInputProtocol: 1 });
  const result = f.backend.advanceResult(task, new AbortController().signal);
  if (state === "payload-conflict" || state === "generation-conflict") await expect(result).rejects.toThrow(/automatic input operation conflicts/);
  else if (state === "ticket-conflict" || state === "future") await expect(result).rejects.toThrow(/conflicts|unsupported-version/);
  else expect(await result).toMatchObject(state === "accepted" ? { kind: "waiting_input", reason: "native_input" } : { kind: "observed" });
  expect(f.source.request.mock.calls.every(([, action]) => action.kind === "observe")).toBe(true);
  expect(f.store.getTask(task)!.webExecution!.executionGeneration).toBe("1");
  expect(readFileSync(f.file)).toEqual(bytes);
});

it.each(["exhausted", "worktree-restored"] as const)("keeps a healthy live v16 original orchestration running (%s)", async state => {
  const f = await liveJournal();
  f.source.stopped.mockResolvedValue(false);
  let task = f.task;
  if (state === "exhausted") for (let count = 0; count < task.configuration!.recoveryLimit; count++) task = f.store.beginRecovery(task, 8 + count);
  else f.store.blockOrchestration(task, { source: "worktree", code: "validation_failed", message: "Restored original worktree." }, 8);
  const result = await f.backend.advance(task, new AbortController().signal);
  expect(result.recovery.pauseReason).toBeNull();
  expect(result.webExecution!.executionGeneration).toBe("1");
  expect(f.store.getOrchestrationBlocker(task)).toBeNull();
  expect(f.source.request).toHaveBeenCalled();
  if (state === "worktree-restored") expect(f.launcher.launch).not.toHaveBeenCalled();
  else expect(f.launcher.launch.mock.calls[0]![1]).toEqual(f.source.ticket);
  expect(readFileSync(f.file)).toEqual(f.bytes);
});

it.each(["ticket", "native-prefix", "future"] as const)("retains a live v16 boundary when %s evidence conflicts", async conflict => {
  const f = await liveJournal(), db = new Database(f.file);
  try {
    if (conflict === "ticket") db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("b".repeat(64));
    else if (conflict === "native-prefix") db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...f.snapshot, nativeProcesses: [] }));
    else db.pragma(`user_version=${currentSqliteVersion(controllerJournalFormat) + 1}`);
  } finally { db.close(); }
  const bytes = readFileSync(f.file), before = f.store.getTask(f.task);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue();
  await expect(f.backend.requestExecutionStop(f.task, Date.now() + 5_000)).rejects.toThrow();
  expect(stop).not.toHaveBeenCalled(); expect(f.store.getTask(f.task)).toEqual(before);
  expect(readFileSync(f.file)).toEqual(bytes);
});

// The Worker reads the real current journal, including the preceding stopped
// generation, before asking the current Controller to submit the frozen input.
const recoveredInitial = async (prepared: boolean) => {
  const f = await orchestrationFixture();
  f.source.saved.mockRestore();
  vi.mocked(lifecycle.readCompatibleControllerSnapshot).mockRestore();
  const nativeId = f.task.resources.nativeSession!.sessionId;
  const file = path.join(controllerExecutionDirectory(f.home, f.source.ticket.executionId), "journal.sqlite");
  let journal = lifecycle.openControllerLifecycleStore(file, f.source.ticket);
  const first = { ...f.source.snapshot, nativeSessionId: nativeId, initialInputState: "not_submitted" as const,
    controllerProcess: process.platform === "win32"
      ? { ...f.source.snapshot.controllerProcess!, jobObjectName: `Local\\Daynight-${f.source.ticket.launchId}` }
      : f.source.snapshot.controllerProcess,
    lifecycle: "stopped" as const, activity: "stopped" as const, nativeStopped: true, stoppedAt: new Date(0).toISOString(), error: null };
  journal.patchSnapshot({ lifecycle: first.lifecycle, activity: first.activity, nativeSessionId: first.nativeSessionId,
    initialInputState: first.initialInputState, nativeStopped: first.nativeStopped, stoppedAt: first.stoppedAt,
    controllerProcess: first.controllerProcess, nativeProcesses: first.nativeProcesses, error: first.error });
  if (prepared) journal.prepareOperation({ operationId: f.source.ticket.initialOperationId, kind: "initial", payload: { text: f.source.ticket.initialPrompt } });
  journal.close();
  if (process.platform === "win32") {
    vi.mocked(lifecycle.recordStoppedControllerGeneration).mockRestore();
    await lifecycle.recordStoppedControllerGeneration(file, f.source.ticket, { jobLease: {} as import("../../../src/commands/controller/windows-job.js").ControllerJobLease });
  }
  let task = f.store.updateWebExecution(f.task, { initialInputState: "not_submitted", activity: "stopped", nativeProcesses: [] }, 10);
  task = f.store.beginWebGeneration(task, first, 11);
  const execution = task.webExecution!;
  const ticket = { ...f.source.ticket, launchId: execution.launchId, executionGeneration: execution.executionGeneration,
    controllerInstanceId: execution.controllerInstanceId, resumeNativeSessionId: nativeId };
  const ticketPath = await writeLaunchTicket(f.home, ticket);
  const controllerProcess = { ...(first.controllerProcess! as processProof.ProcessProof), pid: 989, startedAt: "recovered",
    ...(process.platform === "win32" ? { jobObjectName: `Local\\Daynight-${ticket.launchId}` } : {}) };
  const nativeProcess = { ...controllerProcess, pid: 990, parentPid: controllerProcess.pid, startedAt: "native-recovered" };
  task = f.store.updateWebExecution(task, { ticketPath, launchSubmission: "acknowledged", controllerProcess, nativeProcesses: [nativeProcess] }, 12);
  journal = lifecycle.openControllerLifecycleStore(file, ticket);
  const snapshot = { ...journal.getSnapshot(), lifecycle: "ready" as const, activity: "idle" as const, nativeSessionId: nativeId,
    controllerProcess, nativeProcesses: [nativeProcess], nativeStopped: false, stoppedAt: null, error: null,
    startup: { state: "ready" as const, reasonCode: "ready" as const }, capabilities: { send: true, steer: false, cancel: false, respond: false } };
  journal.patchSnapshot({ lifecycle: snapshot.lifecycle, activity: snapshot.activity, nativeSessionId: snapshot.nativeSessionId,
    controllerProcess: snapshot.controllerProcess, nativeProcesses: snapshot.nativeProcesses, nativeStopped: snapshot.nativeStopped,
    stoppedAt: snapshot.stoppedAt, error: snapshot.error, startup: snapshot.startup, capabilities: snapshot.capabilities });
  journal.close();
  f.launcher.prepare.mockResolvedValue(ticket);
  const request = vi.fn<typeof localClient.requestController>();
  request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "observe") return { requestId: ticket.launchId, ok: true, snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 };
    throw new Error(`Unexpected ${action.kind} request`);
  });
  const backend = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: f.launcher,
    platform: "macos", buildPrompt: () => "replacement must not be used", emit: vi.fn(), now: () => 50_000, request });
  return { ...f, task, ticket, file, snapshot, backend, request };
};

it.each([false, true])("submits the frozen initial operation through ordinary Worker advance with a real recovered journal (prepared=%s)", async prepared => {
  const f = await recoveredInitial(prepared);
  const before = f.store.getTask(f.task)!;
  f.request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "observe") return { requestId: f.ticket.launchId, ok: true, snapshot: f.snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 };
    expect(action).toEqual({ kind: "submit_initial", operationId: f.ticket.initialOperationId });
    const operation = { operationId: f.ticket.initialOperationId, executionGeneration: "2", kind: "initial" as const,
      payload: { text: f.ticket.initialPrompt }, payloadHash: controllerPayloadHash({ kind: "initial", payload: { text: f.ticket.initialPrompt } }),
      state: "confirmed" as const, result: null, error: null, createdAt: 0, updatedAt: 1 };
    const confirmed = { ...f.snapshot, initialInputState: "confirmed" as const };
    const db = new Database(f.file);
    try {
      db.prepare("INSERT INTO operations(id,value,acknowledged) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(operation.operationId, JSON.stringify(operation));
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(confirmed));
    } finally { db.close(); }
    return { requestId: f.ticket.launchId, ok: true, snapshot: confirmed, operation };
  });
  const result = await f.backend.advanceResult(f.task, new AbortController().signal);
  expect(result.kind).toBe("observed");
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe", "submit_initial"]);
  expect(result.task.claimId).toBe(before.claimId);
  expect(result.task.resources).toEqual(before.resources);
  expect(result.task.recovery).toEqual(before.recovery);
  expect(result.task.webExecution).toMatchObject({ executionGeneration: "2", controllerInstanceId: f.ticket.controllerInstanceId,
    initialOperationId: f.ticket.initialOperationId, initialPrompt: f.ticket.initialPrompt, initialInputState: "confirmed" });
});

it("retains an orchestration blocker until the same recovered journal and original worktree are proven", async () => {
  const f = await recoveredInitial(true);
  f.store.blockOrchestration(f.task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 13);
  f.request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "observe") return { requestId: f.ticket.launchId, ok: true, snapshot: f.snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 };
    expect(action).toEqual({ kind: "submit_initial", operationId: f.ticket.initialOperationId });
    return { requestId: f.ticket.launchId, ok: true, snapshot: { ...f.snapshot, initialInputState: "confirmed" } };
  });
  const result = await f.backend.advanceResult(f.task, new AbortController().signal);
  expect(result.kind).toBe("observed");
  expect(f.store.getOrchestrationBlocker(f.task)).toBeNull();
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe", "submit_initial"]);
  expect(f.git.prepareWorktree).toHaveBeenCalled();
  expect(result.task.recovery).toEqual(f.task.recovery);
  expect(result.task.resources).toEqual(f.task.resources);
});

it.each(["missing-journal", "missing-ticket", "missing-stop", "stop-native", "stop-generation", "ticket", "snapshot-native", "snapshot-generation", "payload", "hash", "operation-id", "operation-generation", "operation-kind", "dispatching", "unknown", "confirmed", "failed"] as const)(
  "never submits a recovered initial input when %s evidence is missing, contradictory, or possibly dispatched", async conflict => {
    const f = await recoveredInitial(true);
    if (conflict === "missing-journal") {
      unlinkSync(f.file);
    } else if (conflict === "missing-ticket") {
      unlinkSync(controllerTicketPath(f.home, f.source.ticket.launchId));
    } else {
      const db = new Database(f.file);
      try {
        if (conflict === "missing-stop") db.prepare("DELETE FROM stopped_generations").run();
        else if (conflict === "stop-native" || conflict === "stop-generation") {
          const row = db.prepare("SELECT ticket_hash,snapshot FROM stopped_generations").get() as { ticket_hash: string; snapshot: string };
          const value = JSON.parse(row.snapshot);
          if (conflict === "stop-native") value.nativeSessionId = "different-native";
          else value.executionGeneration = "9";
          db.prepare("UPDATE stopped_generations SET snapshot=? WHERE ticket_hash=?").run(JSON.stringify(value), row.ticket_hash);
        } else if (conflict === "ticket") db.prepare("UPDATE execution SET ticket_hash=? WHERE id=1").run("b".repeat(64));
        else if (conflict === "snapshot-native" || conflict === "snapshot-generation") {
          const row = db.prepare("SELECT snapshot FROM execution WHERE id=1").get() as { snapshot: string };
          const value = JSON.parse(row.snapshot);
          if (conflict === "snapshot-native") value.nativeSessionId = "different-native";
          else value.executionGeneration = "9";
          db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(value));
        } else {
          const row = db.prepare("SELECT value FROM operations WHERE id=?").get(f.ticket.initialOperationId) as { value: string };
          const value = JSON.parse(row.value);
          if (conflict === "payload") value.payload.text = "different";
          else if (conflict === "hash") value.payloadHash = "b".repeat(64);
          else if (conflict === "operation-id") value.operationId = "other";
          else if (conflict === "operation-generation") value.executionGeneration = "9";
          else if (conflict === "operation-kind") value.kind = "send_message";
          else value.state = conflict;
          db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify(value), f.ticket.initialOperationId);
        }
      } finally { db.close(); }
    }
    await expect(f.backend.advanceResult(f.task, new AbortController().signal)).rejects.toThrow();
    expect(f.request.mock.calls.every(([, action]) => action.kind !== "submit_initial")).toBe(true);
    expect(f.store.getTask(f.task)!.resources.nativeSession).toEqual(f.task.resources.nativeSession);
    expect(f.store.getTask(f.task)!.webExecution!.executionGeneration).toBe("2");
  });

it("retains the recovered operation after a lost response and never replays it after Worker restart", async () => {
  const f = await recoveredInitial(false);
  f.request.mockImplementation(async (_ticket, action) => {
    if (action.kind === "observe") return { requestId: f.ticket.launchId, ok: true, snapshot: f.snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 };
    expect(action).toEqual({ kind: "submit_initial", operationId: f.ticket.initialOperationId });
    const operation = { operationId: f.ticket.initialOperationId, executionGeneration: "2", kind: "initial",
      payload: { text: f.ticket.initialPrompt }, payloadHash: controllerPayloadHash({ kind: "initial", payload: { text: f.ticket.initialPrompt } }),
      state: "dispatching", result: null, error: null, createdAt: 0, updatedAt: 1 };
    const db = new Database(f.file);
    try { db.prepare("INSERT INTO operations(id,value,acknowledged) VALUES(?,?,0)").run(operation.operationId, JSON.stringify(operation)); }
    finally { db.close(); }
    throw new localClient.ControllerIpcOutcomeUnknownError("The original input response was lost.");
  });
  expect(await f.backend.advanceResult(f.task, new AbortController().signal)).toMatchObject({ kind: "waiting_input", reason: "native_input" });
  expect(lifecycle.readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "dispatching", executionGeneration: "2" });
  await expect(f.backend.advanceResult(f.task, new AbortController().signal)).rejects.toThrow();
  const restarted = createWebExecutionBackend({ homeDirectory: f.home, store: f.store, git: f.git, launcher: f.launcher,
    platform: "macos", buildPrompt: () => "replacement must not be used", emit: vi.fn(), now: () => 50_001, request: f.request });
  await expect(restarted.advanceResult(f.store.getTask(f.task)!, new AbortController().signal)).rejects.toThrow();
  expect(f.request.mock.calls.filter(([, action]) => action.kind === "submit_initial")).toHaveLength(1);
  expect(lifecycle.readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "dispatching", executionGeneration: "2" });
});

it("does not clear an orchestration blocker when the preceding stopped boundary is missing", async () => {
  const f = await recoveredInitial(false);
  f.store.blockOrchestration(f.task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 13);
  const db = new Database(f.file);
  try { db.prepare("DELETE FROM stopped_generations").run(); } finally { db.close(); }
  await expect(f.backend.advanceResult(f.task, new AbortController().signal)).rejects.toThrow(/preceding stopped generation/);
  expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
  expect(f.request.mock.calls.every(([, action]) => action.kind !== "submit_initial")).toBe(true);
});

it.each(["ordinary", "orchestration"] as const)("waits without replay when journal dispatch advances after a stale %s observation", async mode => {
  const f = await recoveredInitial(true);
  if (mode === "orchestration") f.store.blockOrchestration(f.task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 13);
  f.request.mockImplementation(async (_ticket, action) => {
    expect(action.kind).toBe("observe");
    const db = new Database(f.file);
    try {
      const row = db.prepare("SELECT value FROM operations WHERE id=?").get(f.ticket.initialOperationId) as { value: string };
      const operation = { ...JSON.parse(row.value), executionGeneration: "2", state: "dispatching" };
      db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify(operation), f.ticket.initialOperationId);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify({ ...f.snapshot, initialInputState: "dispatching" }));
    } finally { db.close(); }
    return { requestId: f.ticket.launchId, ok: true, snapshot: f.snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 };
  });
  expect(await f.backend.advanceResult(f.task, new AbortController().signal)).toMatchObject({ kind: "waiting_input", reason: "native_input" });
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
  expect(lifecycle.readControllerOperation(f.file, f.ticket.initialOperationId)?.state).toBe("dispatching");
  expect(f.store.getTask(f.task)!.recovery).toEqual(f.task.recovery);
  if (mode === "orchestration") expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
});


it.each(["ordinary", "orchestration"] as const)("does not submit recovered input to an older Controller during %s advance", async mode => {
  const f = await recoveredInitial(true);
  if (mode === "orchestration") f.store.blockOrchestration(f.task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 13);
  f.request.mockResolvedValue({ requestId: f.ticket.launchId, ok: true, snapshot: f.snapshot, workerInputProtocol: 1 });
  await expect(f.backend.advanceResult(f.task, new AbortController().signal)).rejects.toThrow("does not advertise safe recovered initial input");
  expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
  expect(f.store.getTask(f.task)!.recovery).toEqual(f.task.recovery);
  if (mode === "orchestration") expect(f.store.getOrchestrationBlocker(f.task)).not.toBeNull();
  expect(lifecycle.readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state: "accepted", executionGeneration: "1" });
});

it.skipIf(process.platform === "win32")("retains the recovered fixture's preceding Windows Job stop proof", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const f = await recoveredInitial(true);
    const evidence = await lifecycle.readRecoverableInitialInput(f.file, f.ticket, f.home);
    expect(evidence.snapshot).toMatchObject({ executionGeneration: "2", nativeSessionId: f.ticket.resumeNativeSessionId });
    expect(evidence.operation).toMatchObject({ operationId: f.ticket.initialOperationId, executionGeneration: "1", state: "accepted" });
  } finally { Object.defineProperty(process, "platform", platform); }
});

it.each((["dispatching", "unknown"] as const).flatMap(state => ["1", "2"].map(generation => [state, generation] as const)))(
  "observes %s original input from generation %s after an orchestration block without replay", async (state, generation) => {
    const f = await recoveredInitial(true);
    const snapshot = { ...f.snapshot, initialInputState: state };
    const db = new Database(f.file);
    try {
      const row = db.prepare("SELECT value FROM operations WHERE id=?").get(f.ticket.initialOperationId) as { value: string };
      db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.value), executionGeneration: generation, state }), f.ticket.initialOperationId);
      db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot));
    } finally { db.close(); }
    const task = f.store.updateWebExecution(f.task, { initialInputState: state }, 13);
    f.store.blockOrchestration(task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 14);
    f.request.mockResolvedValue({ requestId: f.ticket.launchId, ok: true, snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 });
    expect(await f.backend.advanceResult(task, new AbortController().signal)).toMatchObject({ kind: "waiting_input", reason: "native_input" });
    expect(f.request.mock.calls.map(([, action]) => action.kind)).toEqual(["observe"]);
    expect(f.store.getOrchestrationBlocker(task)).toBeNull();
    expect(f.store.getTask(task)!.recovery).toEqual(task.recovery);
    expect(lifecycle.readControllerOperation(f.file, f.ticket.initialOperationId)).toMatchObject({ state, executionGeneration: generation });
  });

it.each(["hash", "payload", "future"] as const)("keeps the orchestration block for conflicting current initial %s evidence", async conflict => {
  const f = await recoveredInitial(true);
  const snapshot = { ...f.snapshot, initialInputState: "unknown" as const };
  const db = new Database(f.file);
  try {
    const row = db.prepare("SELECT value FROM operations WHERE id=?").get(f.ticket.initialOperationId) as { value: string };
    const operation = { ...JSON.parse(row.value), executionGeneration: "2", state: "unknown" };
    if (conflict === "hash") operation.payloadHash = "b".repeat(64);
    if (conflict === "payload") operation.payload = { text: "different" };
    if (conflict === "future") operation.executionGeneration = "3";
    db.prepare("UPDATE operations SET value=? WHERE id=?").run(JSON.stringify(operation), f.ticket.initialOperationId);
    db.prepare("UPDATE execution SET snapshot=? WHERE id=1").run(JSON.stringify(snapshot));
  } finally { db.close(); }
  const task = f.store.updateWebExecution(f.task, { initialInputState: "unknown" }, 13);
  f.store.blockOrchestration(task, { source: "worktree", code: "validation_failed", message: "Temporary worktree deviation." }, 14);
  f.request.mockResolvedValue({ requestId: f.ticket.launchId, ok: true, snapshot, workerInputProtocol: 1, recoveredInitialInputProtocol: 1 });
  await expect(f.backend.advanceResult(task, new AbortController().signal)).rejects.toThrow();
  expect(f.store.getOrchestrationBlocker(task)).not.toBeNull();
  expect(f.request.mock.calls.every(([, action]) => action.kind !== "submit_initial")).toBe(true);
});
