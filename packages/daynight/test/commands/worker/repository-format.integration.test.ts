import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { prepareWorkerWorktreeFormat } from "../../../src/commands/worker/repository-admission.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";
import type { WorkerHerdrAdapter } from "../../../src/commands/worker/herdr.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
const fixture = () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/repository-format"); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "case-")); roots.push(root);
  const repo = path.join(root, "repo"); mkdirSync(repo);
  git(repo, ["init", "--initial-branch=main"]); git(repo, ["config", "user.name", "Fixture"]); git(repo, ["config", "user.email", "fixture@example.test"]);
  git(repo, ["config", "core.autocrlf", "false"]); git(repo, ["config", "core.eol", "lf"]);
  writeFileSync(path.join(repo, "tracked"), "contents\n"); git(repo, ["add", "tracked"]); git(repo, ["commit", "-m", "fixture"]);
  const commonDirectory = git(repo, ["rev-parse", "--absolute-git-dir"]);
  const owner = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const cwd = path.join(repo, ".worktrees", "daynight", owner.taskId); mkdirSync(path.dirname(cwd), { recursive: true });
  const marker = `daynight-worker:${JSON.stringify({ ...owner, leaf: "1:1", root: "2:2", common: "3:3" })}`;
  git(repo, ["worktree", "add", "--lock", "--reason", marker, "-b", `daynight/${owner.taskId}`, "--", cwd]);
  const admin = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  const paths = { ...resolveWorkerPaths(root), workerDirectory: path.join(root, "worker"), herdrDirectory: path.join(root, "herdr") }; mkdirSync(paths.workerDirectory, { recursive: true });
  const store = openWorkerStore(path.join(root, "state.sqlite"));
  const project = { projectId: owner.projectId, repoUrl: "https://example.test/repo.git", localPath: repo };
  const repository = { root: repo, commonDirectory, rootIdentity: "test", commonIdentity: "test" };
  const operation = createOperation();
  return { root, repo, commonDirectory, owner, cwd, admin, paths, store, project, repository, operation, close: () => { operation.dispose(); store.close(); } };
};

it("activates migration for an existing locked checkout and retains its original cwd", async () => {
  const f = fixture();
  try {
    await prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("absent backend should not start"); } });
    const manifest = createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId);
    expect(manifest).toMatchObject({ ...f.owner, directoryName: f.owner.taskId });
    expect(existsSync(path.join(f.admin, "locked"))).toBe(false);
    expect(readFileSync(path.join(f.cwd, "tracked"), "utf8")).toBe("contents\n");
    expect(JSON.parse(readFileSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"), "utf8"))).toEqual({ version: 1 });
  } finally { f.close(); }
});

it("keeps the original marker and format closed when a retained backend cannot be observed", async () => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.paths.herdrDirectory, "c", "herdr", "sessions", "w"), { recursive: true });
    const failure = new Error("original Herdr observation failed");
    const herdr = { ensureInstance: async () => ({}), tasks: { listResources: async () => { throw failure; }, pendingStops: () => [] } } as unknown as WorkerHerdrAdapter;
    await expect(prepareWorkerWorktreeFormat({ ...f, platform: "linux", getHerdr: async () => herdr })).rejects.toBe(failure);
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"))).toBe(false);
    expect(readFileSync(path.join(f.cwd, "tracked"), "utf8")).toBe("contents\n");
  } finally { f.close(); }
});

it("keeps the gate closed when a same-repository lifecycle belongs to an unobservable original server", async () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.paths.workerDirectory, "herdr-executions.sqlite"), "journal fixture");
    const failure = new Error("foreign original archive is unavailable");
    const herdr = { lifecycle: { archive: { resources: () => [] }, migration: {
      listLifecycles: () => [{ owner: { projectId: randomUUID() }, cwd: f.cwd }], listRetired: () => [],
      assertOrigin: () => { throw failure; }, listBindings: async () => [],
    } }, tasks: { pendingStops: () => [] } } as unknown as WorkerHerdrAdapter;
    await expect(prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => herdr })).rejects.toBe(failure);
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"))).toBe(false);
  } finally { f.close(); }
});

it("imports an unlocked original checkout from its persisted Web binding", async () => {
  const f = fixture();
  try {
    git(f.repo, ["worktree", "unlock", "--", f.cwd]);
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
    const task = web.register({ ...f.owner, project: f.project, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(),
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    web.bindWorktree(task, { repositoryPath: f.repo, commonDirectory: f.commonDirectory, worktreePath: f.cwd, branch: `daynight/${f.owner.taskId}` }, 2);
    web.close();
    await prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("absent backend should not start"); } });
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).toMatchObject({ ...f.owner, directoryName: f.owner.taskId });
    const reopened = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
    try { expect(reopened.getTask(f.owner)?.resources.worktree?.worktreePath).toBe(f.cwd); } finally { reopened.close(); }
  } finally { f.close(); }
});

it("imports another project's binding in the same repository without importing unrelated repositories", async () => {
  const f = fixture();
  try {
    const foreign = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
    const foreignCwd = path.join(f.repo, ".worktrees", "daynight", foreign.taskId);
    git(f.repo, ["worktree", "add", "-b", `daynight/${foreign.taskId}`, "--", foreignCwd]);
    const unrelated = { projectId: randomUUID(), taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
    const otherRoot = path.join(f.root, "other-repo"); mkdirSync(otherRoot);
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
    const configuration = { agent: "codex" as const, agentControlMode: "web" as const, model: null, args: [], recoveryLimit: 2 };
    const task = web.register({ ...foreign, project: { ...f.project, projectId: foreign.projectId }, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(), configuration }, 1);
    web.bindWorktree(task, { repositoryPath: f.repo, commonDirectory: f.commonDirectory, worktreePath: foreignCwd, branch: `daynight/${foreign.taskId}` }, 2);
    web.register({ ...unrelated, project: { ...f.project, projectId: unrelated.projectId, localPath: otherRoot }, serverOrigin: "https://daynight.example", workerId: randomUUID(), userId: randomUUID(), configuration }, 1);
    web.close();
    await prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("absent backend should not start"); } });
    const manifests = createWorktreeManifestStore(f.commonDirectory);
    expect(manifests.read(foreign.worktreeId)).toMatchObject({ ...foreign, directoryName: foreign.taskId });
    expect(manifests.read(unrelated.worktreeId)).toBeNull();
    expect(readFileSync(path.join(foreignCwd, "tracked"), "utf8")).toBe("contents\n");
  } finally { f.close(); }
});

it("retains the legacy lock when an unfinished Web execution has no observable original record", async () => {
  const f = fixture();
  try {
    f.store.registerProject(f.project);
    f.store.activateTask(f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" }));
    f.store.saveCleanupSchedule(f.owner, { deadline: 100, failures: 0, nextAttemptAt: 0, stage: "observation", lastError: null });
    // The Web store may have been recreated before migration begins.
    openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} }).close();
    const failure = new Error("original Session registration cannot be observed");
    const observed: unknown[] = [];
    await expect(prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("unexpected Herdr"); },
      verifyWebUnregistered: async (identity, signal) => { observed.push({ identity, signal }); throw failure; },
    })).rejects.toBe(failure);
    expect(observed).toEqual([{ identity: { projectId: f.owner.projectId, taskId: f.owner.taskId, claimId: f.owner.claimId }, signal: f.operation.signal }]);
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"))).toBe(false);
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).toBeNull();
  } finally { f.close(); }
});

it("accepts a missing Web record only after the exact original claim is proven unregistered", async () => {
  const f = fixture();
  try {
    f.store.registerProject(f.project);
    f.store.activateTask(f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" }));
    const observed: unknown[] = [];
    await prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("unexpected Herdr"); },
      verifyWebUnregistered: async (identity, signal) => { observed.push({ identity, signal }); },
    });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every(value => JSON.stringify((value as { identity: unknown }).identity) === JSON.stringify({ projectId: f.owner.projectId, taskId: f.owner.taskId, claimId: f.owner.claimId }))).toBe(true);
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).toMatchObject({ ...f.owner, directoryName: f.owner.taskId });
    expect(existsSync(path.join(f.admin, "locked"))).toBe(false);
  } finally { f.close(); }
});

it("never treats a registered native Session as an unregistered Web claim", async () => {
  const f = fixture();
  try {
    f.store.registerProject(f.project);
    f.store.activateTask(f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web", sessionId: randomUUID() }));
    let called = false;
    await expect(prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("unexpected Herdr"); },
      verifyWebUnregistered: async () => { called = true; },
    })).rejects.toThrow("original Web execution evidence is missing");
    expect(called).toBe(false);
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"))).toBe(false);
  } finally { f.close(); }
});


it("retains the old format when another project in the same repository has unobservable Herdr ownership", async () => {
  const f = fixture();
  try {
    const otherProject = { ...f.project, projectId: randomUUID() };
    const other = { projectId: otherProject.projectId, taskId: randomUUID(), claimId: randomUUID() };
    f.store.registerProject(otherProject);
    f.store.registerPending({ ...other, agent: "codex", agentControlMode: "herdr" });
    await expect(prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("unexpected Herdr"); } })).rejects.toThrow("original Herdr backend cannot be observed");
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"))).toBe(false);
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).toBeNull();
  } finally { f.close(); }
}, 30_000);

it("does not infer an unrelated repository when an unfinished Herdr binding is missing", async () => {
  const f = fixture();
  try {
    const otherProject = { ...f.project, projectId: randomUUID() };
    const other = { projectId: otherProject.projectId, taskId: randomUUID(), claimId: randomUUID() };
    f.store.registerProject(otherProject);
    f.store.registerPending({ ...other, agent: "codex", agentControlMode: "herdr" });
    const original = f.store.getProject;
    vi.spyOn(f.store, "getProject").mockImplementation(identity => identity.projectId === otherProject.projectId ? null : original(identity));
    await expect(prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("unexpected Herdr"); } })).rejects.toThrow("unfinished Herdr task has no original repository binding");
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(existsSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"))).toBe(false);
  } finally { vi.restoreAllMocks(); f.close(); }
}, 30_000);

it("does not block a repository for an unrelated Herdr task", async () => {
  const f = fixture();
  try {
    const otherRoot = path.join(f.root, "other-repo"); mkdirSync(otherRoot);
    const otherProject = { ...f.project, projectId: randomUUID(), localPath: otherRoot };
    f.store.registerProject(otherProject);
    f.store.registerPending({ projectId: otherProject.projectId, taskId: randomUUID(), claimId: randomUUID(), agent: "codex", agentControlMode: "herdr" });
    await prepareWorkerWorktreeFormat({ ...f, platform: "macos", getHerdr: async () => { throw new Error("unexpected Herdr"); } });
    expect(existsSync(path.join(f.admin, "locked"))).toBe(false);
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).not.toBeNull();
  } finally { f.close(); }
}, 30_000);
