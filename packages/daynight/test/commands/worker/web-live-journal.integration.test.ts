import { restoreControllerJournalVersion } from "../../helpers/controller-journal-version.js";
import path from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import * as launchObservation from "../../../src/commands/controller/launch-observation.js";
import * as localClient from "../../../src/commands/controller/local-client.js";
import { controllerExecutionDirectory, controllerPayloadHash, writeLaunchTicket } from "../../../src/commands/controller/launch-ticket.js";
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
  try { restoreControllerJournalVersion(db, 16); db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid); }
  finally { db.close(); }
  const bytes = readFileSync(file);
  expect(() => lifecycle.readControllerSnapshot(file)).toThrow();
  expect(() => lifecycle.readCurrentControllerSnapshot(file, f.source.ticket)).toThrow(/current journal format/);
  expect(readFileSync(file)).toEqual(bytes);
  return { ...f, file, bytes };
};

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
    if (state === "future") db.pragma("user_version=19");
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
    else db.pragma("user_version=19");
  } finally { db.close(); }
  const bytes = readFileSync(f.file), before = f.store.getTask(f.task);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue();
  await expect(f.backend.requestExecutionStop(f.task, Date.now() + 5_000)).rejects.toThrow();
  expect(stop).not.toHaveBeenCalled(); expect(f.store.getTask(f.task)).toEqual(before);
  expect(readFileSync(f.file)).toEqual(bytes);
});
