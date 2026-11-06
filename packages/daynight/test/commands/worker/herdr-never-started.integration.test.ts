import path from "node:path";
import Database from "better-sqlite3";
import { createOperation } from "../../../src/api/operation.js";
import { ApiError } from "../../../src/api/client.js";
import { execFileSync } from "node:child_process";
import { runRepositoryGit } from "../../../src/repository/git.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { afterEach, expect, it, onTestFailed, vi } from "vitest";
import { createDurableWorkerHerdr } from "../../../src/commands/worker/herdr/durable.js";
import { openHerdrLifecycleStore } from "../../../src/commands/worker/herdr/lifecycle-store.js";
import { createWorkerCoordinator } from "../../../src/commands/worker/coordinator.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import type { WorkerRemote } from "../../../src/commands/worker/remote.js";
import type { WorkerGitManager, WorkerEvent } from "../../../src/commands/worker/execution.js";
import type { WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";
import type { Task } from "../../../src/api/types.js";
import type { ResourceOwner } from "../../../src/commands/worker/types.js";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = "https://daynight.example", workerId = uuid(1), userId = uuid(2);
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
const fixture = () => {
  const base = path.resolve(import.meta.dirname, "../../../../../.tmp/herdr-never-started"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, "case-")); cleanups.push(() => rmSync(root, { force: true, recursive: true }));
  const paths = resolveWorkerPaths(root); mkdirSync(paths.workerDirectory, { recursive: true });
  let store = openWorkerStore(paths.databaseFile); cleanups.push(() => store.close());
  const project = { projectId: uuid(3), repoUrl: "https://example.test/org/repo.git", localPath: path.join(root, "repo") }; mkdirSync(project.localPath); store.registerProject(project);
  const tasks = new Map<string, Task>(), events: WorkerEvent[] = [];
  const remote = { serverOrigin: origin, currentUserId: vi.fn(async () => userId), readTask: vi.fn(async (_project: string, id: string) => tasks.get(id)!), ownInventory: vi.fn(async () => [] as Task[]), candidates: vi.fn(async function* () {}), claim: vi.fn() } as unknown as WorkerRemote;
  const git = { listWorktrees: vi.fn(async () => []), findWorktree: vi.fn(async () => null), prepareWorktree: vi.fn(async () => { throw new Error("Preparation failed before creating resources."); }), removeWorktree: vi.fn(), removeEmptyReservation: vi.fn() } as unknown as WorkerGitManager;
  const open = () => createDurableWorkerHerdr({ paths, homeDirectory: root, serverOrigin: origin, serverToken: "fixture", workerId, readTask: (...args) => remote.readTask(...args), currentUserId: (...args) => remote.currentUserId(...args), createAdapter: () => ({}) as WorkerHerdrAdapter });
  let herdr = open(); cleanups.push(() => herdr.lifecycle!.close());
  const configuration = { agent: "codex" as const, agentControlMode: "herdr" as const, args: [], model: null, recoveryLimit: 0 };
  const coordinator = (selected = false) => createWorkerCoordinator({ store, remote, git, herdr, serverOrigin: origin, workerId, platform: "macos", machine: { id: uuid(4), name: "fixture" }, repositories: selected ? [{ project, configuration }] : [], globalConfiguration: configuration, maxConcurrent: 1, hasHerdrJournal: true, availableDiskBytes: () => 10_000_000_000n, buildPrompt: () => "fixture", emit: event => events.push(event) });
  const register = (n: number) => {
    const owner: ResourceOwner = { projectId: project.projectId, taskId: uuid(100 + n), claimId: uuid(200 + n), worktreeId: uuid(300 + n) };
    const task = { id: owner.taskId, projectId: owner.projectId, status: "in_progress", allowAgents: true, properties: { worker: { claimId: owner.claimId, worktreeId: owner.worktreeId, userId, workerId, state: "active", agent: "codex", agentControlMode: "herdr", platform: "macos", machine: { id: uuid(4), name: "fixture" }, phase: "preparing", herdr: null, nativeSessionId: null, claimedAt: "2026-11-05T00:00:00Z" } } } as unknown as Task;
    tasks.set(owner.taskId, task); store.registerPending({ ...owner, agent: "codex", agentControlMode: "herdr" }); coordinator().registerClaim(task); return owner;
  };
  const end = (owner: ResourceOwner) => { const task = tasks.get(owner.taskId)!; tasks.set(owner.taskId, { ...task, status: "done", properties: { worker: { ...(task.properties.worker as object), state: "completed" } } }); };
  const read = (owner: ResourceOwner) => { const reader = openHerdrLifecycleStore(path.join(paths.workerDirectory, "herdr-executions.sqlite")); try { return reader.get(owner)!; } finally { reader.close(); } };
  const reopen = () => { herdr.lifecycle!.close(); store.close(); store = openWorkerStore(paths.databaseFile); herdr = open(); };
  return { root, paths, project, remote, git, tasks, events, register, end, read, reopen, coordinator, get store() { return store; }, get herdr() { return herdr; } };
};
it("retires twenty terminal claims that never acquired resources before enforcing admission budgets", async () => {
  const f = fixture(), owners = Array.from({ length: 20 }, (_, n) => f.register(n)); owners.forEach(f.end);
  f.reopen(); expect(f.read(owners[0]!).controlEpoch).not.toBe("0");
  const coordinator = f.coordinator();
  expect(() => coordinator.assertCanAcquire({ projectId: f.project.projectId, taskId: uuid(999) })).toThrow("budget");
  await coordinator.tick();
  expect(f.herdr.lifecycle!.archive!.resources()).toEqual([]);
  expect(f.herdr.lifecycle!.responsibilities()).toEqual([]);
  expect(() => coordinator.assertCanAcquire({ projectId: f.project.projectId, taskId: uuid(999) })).not.toThrow();
  expect(f.store.listUnfinishedTasks()).toEqual([]);
  expect(f.git.removeWorktree).not.toHaveBeenCalled(); expect(f.git.removeEmptyReservation).not.toHaveBeenCalled();
  for (const owner of owners) expect(f.read(owner)).toMatchObject({ preparation: null, runs: [], segments: [], connectionEpoch: null, publishedLedgerHash: null });
  f.reopen(); await f.coordinator().tick(); expect(f.herdr.lifecycle!.archive!.resources()).toEqual([]);
});

const retirement = async (f: ReturnType<typeof fixture>, owner: ResourceOwner, verify: (cwd: string) => Promise<void> = async () => {}) => {
  const operation = createOperation();
  try { await f.herdr.lifecycle!.neverStarted!.retire(owner, operation, verify); } finally { operation.dispose(); }
};
it.each(["active", "wrong-user", "wrong-worker", "wrong-worktree", "missing-claim", "hidden-404"])("retains unknown or unauthorized original ownership: %s", async kind => {
  const f = fixture(), owner = f.register(0); if (kind !== "active") f.end(owner);
  const task = f.tasks.get(owner.taskId)!;
  if (kind === "wrong-user") vi.mocked(f.remote.currentUserId).mockResolvedValue(uuid(900));
  if (kind === "wrong-worker" || kind === "wrong-worktree") f.tasks.set(owner.taskId, { ...task, properties: { worker: { ...(task.properties.worker as object), [kind === "wrong-worker" ? "workerId" : "worktreeId"]: uuid(901) } } });
  if (kind === "missing-claim") f.tasks.set(owner.taskId, { ...task, properties: {} });
  if (kind === "hidden-404") vi.mocked(f.remote.readTask).mockRejectedValue(new ApiError({ operation: "task.show", projectId: owner.projectId, taskId: owner.taskId }, "response", { status: 404, serverError: { code: "not_found", message: "Hidden", requestId: "fixture" }, cause: new Error("Hidden") }));
  await expect(retirement(f, owner)).rejects.toThrow();
  expect(f.herdr.lifecycle!.responsibilities()).toHaveLength(1);
});
it.each(["cwd", "source", "archive", "symlink"])("retains a never-started registration with %s resources", async kind => {
  const f = fixture(), owner = f.register(0); f.end(owner); const record = f.read(owner);
  if (kind === "cwd") mkdirSync(record.cwd, { recursive: true });
  if (kind === "source") mkdirSync(path.join(f.paths.workerDirectory, "herdr-recordings", record.sessionId), { recursive: true });
  if (kind === "archive") writeFileSync(path.join(f.paths.workerDirectory, "herdr-archives", `${record.sessionId}.archive-state.json`), "");
  if (kind === "symlink") { mkdirSync(path.dirname(record.cwd), { recursive: true }); symlinkSync(path.join(f.root, "missing"), record.cwd); }
  await expect(retirement(f, owner)).rejects.toThrow();
  expect(f.herdr.lifecycle!.neverStarted!.retired()).toEqual([]);
});
it("rejects resources or lifecycle evidence that appear during asynchronous Git verification", async () => {
  const f = fixture(), owner = f.register(0); f.end(owner);
  await expect(retirement(f, owner, async cwd => { mkdirSync(cwd, { recursive: true }); })).rejects.toThrow(/resources/);
  rmSync(f.read(owner).cwd, { recursive: true });
  await expect(retirement(f, owner, async () => {
    const writer = openHerdrLifecycleStore(path.join(f.paths.workerDirectory, "herdr-executions.sqlite"));
    try { writer.update(writer.get(owner)!, draft => { draft.preparation = { instanceId: "changed", instanceDirectory: f.root, phase: "prepared", daemon: null }; }); } finally { writer.close(); }
  })).rejects.toThrow(/changed/);
  expect(f.herdr.lifecycle!.neverStarted!.retired()).toEqual([]);
});
it("retires an old claim replaced by an active successor and never revisits its reused path", async () => {
  const f = fixture(), owner = f.register(0), task = f.tasks.get(owner.taskId)!;
  f.tasks.set(owner.taskId, { ...task, properties: { worker: { ...(task.properties.worker as object), claimId: uuid(999), worktreeId: uuid(998), workerId: uuid(997), userId: uuid(996) } } });
  await f.coordinator().tick(); expect(f.herdr.lifecycle!.neverStarted!.retired()).toHaveLength(1);
  const cwd = f.read(owner).cwd; mkdirSync(cwd, { recursive: true }); writeFileSync(path.join(cwd, "successor"), "preserve");
  f.reopen(); vi.mocked(f.git.findWorktree).mockClear();
  await f.coordinator().tick();
  expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(existsSync(path.join(cwd, "successor"))).toBe(true);
});
it.each(["UPDATE", "DELETE"])("recovers SQLite %s failure after durable retirement without inspecting reused paths", async statement => {
  const f = fixture(), owner = f.register(0); f.end(owner); f.store.activateTask(f.store.getTask(owner)!);
  f.store.saveCleanupSchedule(owner, { deadline: 10000, failures: 0, nextAttemptAt: 0, stage: "worktree-removal", lastError: null });
  const db = new Database(f.paths.databaseFile);
  db.exec(`CREATE TRIGGER reject_retirement BEFORE ${statement} ON ${statement === "UPDATE" ? "tasks" : "cleanup_schedules"} BEGIN SELECT RAISE(FAIL, 'retirement write blocked'); END`);
  try { await expect(f.coordinator().tick()).rejects.toThrow("retirement write blocked"); expect(f.herdr.lifecycle!.neverStarted!.retired()).toHaveLength(1); expect(f.remote.candidates).not.toHaveBeenCalled(); expect(() => f.coordinator().assertCanAcquire({ projectId: owner.projectId, taskId: uuid(999) })).toThrow("retirement write blocked"); }
  finally { db.exec("DROP TRIGGER reject_retirement"); db.close(); }
  const cwd = f.read(owner).cwd; mkdirSync(cwd, { recursive: true }); writeFileSync(path.join(cwd, "successor"), "preserve");
  f.reopen(); vi.mocked(f.git.findWorktree).mockClear(); await f.coordinator().tick();
  expect(f.store.getTask(owner)?.status).toBe("done"); expect(f.store.getCleanupSchedule(owner)).toBeNull();
  expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(existsSync(path.join(cwd, "successor"))).toBe(true);
});
it("retains a real Git worktree created before any native preparation journal", async () => {
  const f = fixture(), owner = f.register(0); f.end(owner);
  const pending: { phase: string; startedAt: number }[] = [], completed: { phase: string; elapsedMs: number }[] = [];
  const begin = (phase: string) => {
    const stage = { phase, startedAt: performance.now() }; pending.push(stage);
    return () => { completed.push({ phase, elapsedMs: performance.now() - stage.startedAt }); pending.splice(pending.indexOf(stage), 1); };
  };
  onTestFailed(() => { console.error(JSON.stringify({ kind: "never-started-git-diagnostic", pending: pending.map(stage => ({ phase: stage.phase, elapsedMs: performance.now() - stage.startedAt })), completed })); });
  const git = (phase: string, ...args: string[]) => { const end = begin(phase); try { return execFileSync("git", args, { cwd: f.project.localPath, stdio: "pipe", timeout: 10000 }); } finally { end(); } };
  git("init", "init"); git("config", "config", "remote.origin.url", f.project.repoUrl); git("commit", "-c", "core.hooksPath=" + path.join(f.root, "no-hooks"), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--no-gpg-sign", "--allow-empty", "-m", "Fixture");
  const manager = createWorkerGitManager({ temporaryDirectory: f.paths.temporaryDirectory, runGit: async (...args) => {
    const command = args[1][4]!, end = begin(`manager:${command.startsWith("--git-dir=") ? args[1][5] : command}`);
    try { return await runRepositoryGit(...args); } finally { end(); }
  } }), operation = createOperation();
  try {
    const prepared = begin("prepare-worktree"); try { await manager.prepareWorktree(f.project, owner, operation); } finally { prepared(); }
    expect(f.read(owner)).toMatchObject({ preparation: null, runs: [] });
    await expect(retirement(f, owner, async () => { if (await manager.findWorktree(f.project, owner, operation)) throw new Error("Git registration remains"); })).rejects.toThrow();
    // Missing directory still leaves an authoritative Git registration; path absence alone is insufficient.
    rmSync(f.read(owner).cwd, { recursive: true, force: true });
    await expect(retirement(f, owner, async () => { if (await manager.findWorktree(f.project, owner, operation)) throw new Error("Git registration remains"); })).rejects.toThrow();
    expect(f.herdr.lifecycle!.neverStarted!.retired()).toEqual([]);
  } finally { operation.dispose(); await manager.dispose(); }
});
it.each(["exact", "wrong-task", "unconfirmed"])("requires an authoritative original deletion response: %s", async kind => {
  const f = fixture(), owner = f.register(0);
  vi.mocked(f.remote.readTask).mockRejectedValue(new ApiError({ operation: "task.show", projectId: owner.projectId, taskId: kind === "wrong-task" ? uuid(999) : owner.taskId }, "response", { status: 410, serverError: { code: "task_deleted", message: "Deleted", requestId: "fixture" }, outcomeUnconfirmed: kind === "unconfirmed", cause: new Error("Deleted") }));
  if (kind === "exact") { await retirement(f, owner); expect(f.herdr.lifecycle!.neverStarted!.retired()).toHaveLength(1); }
  else { await expect(retirement(f, owner)).rejects.toThrow(); expect(f.herdr.lifecycle!.responsibilities()).toHaveLength(1); }
});
it("waits for the original preparation job to settle before retiring its failed registration", async () => {
  const f = fixture(), owner = f.register(0), coordinator = f.coordinator(true);
  vi.mocked(f.remote.ownInventory).mockImplementation(async () => [f.tasks.get(owner.taskId)!]);
  let rejectPreparation!: (error: Error) => void;
  vi.mocked(f.git.prepareWorktree).mockImplementation(() => new Promise((_resolve, reject) => { rejectPreparation = reject; }));
  await coordinator.tick();
  await vi.waitFor(() => expect(f.git.prepareWorktree).toHaveBeenCalledOnce());
  f.end(owner); vi.mocked(f.remote.ownInventory).mockResolvedValue([]);
  await coordinator.tick(); expect(f.herdr.lifecycle!.neverStarted!.retired()).toEqual([]);
  rejectPreparation(new Error("Preparation failed before acquiring resources."));
  await new Promise<void>(resolve => setImmediate(resolve));
  await coordinator.tick();
  expect(f.herdr.lifecycle!.neverStarted!.retired()).toHaveLength(1);
  expect(f.store.getTask(owner)?.status).toBe("done");
  expect(await coordinator.shutdown()).toBe(true);
});

it("does not require a historical project mapping after retired local bookkeeping converges", async () => {
  const f = fixture(), owner = f.register(0); f.end(owner); await f.coordinator().tick(); f.reopen();
  vi.spyOn(f.store, "getProject").mockReturnValue(null); vi.spyOn(f.store, "listProjects").mockReturnValue([]);
  vi.mocked(f.git.findWorktree).mockClear();
  const coordinator = f.coordinator(); await coordinator.tick();
  expect(() => coordinator.assertCanAcquire({ projectId: uuid(999), taskId: uuid(998) })).not.toThrow();
  expect(f.git.findWorktree).not.toHaveBeenCalled(); expect(await coordinator.shutdown()).toBe(true);
});
