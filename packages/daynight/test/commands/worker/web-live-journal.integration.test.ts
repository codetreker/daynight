import path from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { createWebBackendFixtures } from "./web-backend.fixtures.js";
import * as lifecycle from "../../../src/commands/controller/lifecycle-store.js";
import * as processProof from "../../../src/commands/controller/process-proof.js";
import { controllerExecutionDirectory } from "../../../src/commands/controller/launch-ticket.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { createMemoryDatabase } from "../../helpers/sqlite.js";
import type { Task } from "../../../src/api/types.js";

const { orchestrationFixture } = createWebBackendFixtures("file");

const liveJournal = async () => {
  const f = await orchestrationFixture();
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
  try { db.exec("DROP TABLE stopped_generations; PRAGMA user_version=16"); db.prepare("UPDATE execution SET owner_pid=? WHERE id=1").run(process.pid); }
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
    preferPlatformSpecificTasks: false, git: f.git, remote: { currentUserId: async () => f.task.userId!, readTask: async () => task } as never,
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
    else db.pragma("user_version=18");
  } finally { db.close(); }
  const bytes = readFileSync(f.file), before = f.store.getTask(f.task);
  const stop = vi.spyOn(processProof, "stopControllerProcesses").mockResolvedValue();
  await expect(f.backend.requestExecutionStop(f.task, Date.now() + 5_000)).rejects.toThrow();
  expect(stop).not.toHaveBeenCalled(); expect(f.store.getTask(f.task)).toEqual(before);
  expect(readFileSync(f.file)).toEqual(bytes);
});
