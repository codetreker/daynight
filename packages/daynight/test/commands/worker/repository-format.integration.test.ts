import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { prepareWorkerWorktreeFormat } from "../../../src/commands/worker/repository-admission.js";
import { openWorkerStore } from "../../../src/commands/worker/store.js";
import { openWebExecutionStore } from "../../../src/commands/worker/backends/web-store.js";
import { resolveWorkerPaths } from "../../../src/commands/worker/paths.js";

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
  const paths = { ...resolveWorkerPaths(root), workerDirectory: path.join(root, "worker") }; mkdirSync(paths.workerDirectory, { recursive: true });
  const store = openWorkerStore(path.join(root, "state.sqlite"));
  const project = { projectId: owner.projectId, repoUrl: "https://example.test/repo.git", localPath: repo };
  const repository = { root: repo, commonDirectory, rootIdentity: "test", commonIdentity: "test" };
  const operation = createOperation();
  const serverOrigin = "https://daynight.example", workerId = randomUUID(), userId = randomUUID();
  const registerWeb = (target = owner, rootPath = repo) => {
    const web = openWebExecutionStore(path.join(paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
    const task = web.register({ ...target, project: { ...project, projectId: target.projectId, localPath: rootPath }, serverOrigin, workerId, userId,
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    web.bindWorktree(task, { repositoryPath: rootPath, commonDirectory: rootPath === repo ? commonDirectory : path.join(rootPath, ".git"), worktreePath: path.join(rootPath, ".worktrees", "daynight", target.taskId), branch: `daynight/${target.taskId}` }, 2);
    web.close();
  };
  return { root, repo, commonDirectory, owner, cwd, admin, paths, store, project, repository, operation, serverOrigin, workerId, userId, registerWeb, close: () => { operation.dispose(); store.close(); } };
};

it("activates migration for an existing locked checkout and retains its original cwd", async () => {
  const f = fixture();
  try {
    f.registerWeb();
    await prepareWorkerWorktreeFormat(f);
    const manifest = createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId);
    expect(manifest).toMatchObject({ ...f.owner, directoryName: f.owner.taskId });
    expect(existsSync(path.join(f.admin, "locked"))).toBe(false);
    expect(readFileSync(path.join(f.cwd, "tracked"), "utf8")).toBe("contents\n");
    expect(JSON.parse(readFileSync(path.join(f.commonDirectory, "daynight", "worktrees", "format.json"), "utf8"))).toEqual({ version: 1 });
  } finally { f.close(); }
});

it("imports an unlocked original checkout from its persisted Web binding", async () => {
  const f = fixture();
  try {
    git(f.repo, ["worktree", "unlock", "--", f.cwd]);
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
    const task = web.register({ ...f.owner, project: f.project, serverOrigin: f.serverOrigin, workerId: f.workerId, userId: f.userId,
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    web.bindWorktree(task, { repositoryPath: f.repo, commonDirectory: f.commonDirectory, worktreePath: f.cwd, branch: `daynight/${f.owner.taskId}` }, 2);
    web.close();
    await prepareWorkerWorktreeFormat(f);
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
    const task = web.register({ ...foreign, project: { ...f.project, projectId: foreign.projectId }, serverOrigin: f.serverOrigin, workerId: f.workerId, userId: f.userId, configuration }, 1);
    web.bindWorktree(task, { repositoryPath: f.repo, commonDirectory: f.commonDirectory, worktreePath: foreignCwd, branch: `daynight/${foreign.taskId}` }, 2);
    web.register({ ...unrelated, project: { ...f.project, projectId: unrelated.projectId, localPath: otherRoot }, serverOrigin: f.serverOrigin, workerId: f.workerId, userId: f.userId, configuration }, 1);
    web.close();
    await prepareWorkerWorktreeFormat(f);
    const manifests = createWorktreeManifestStore(f.commonDirectory);
    expect(manifests.read(foreign.worktreeId)).toMatchObject({ ...foreign, directoryName: foreign.taskId });
    expect(manifests.read(unrelated.worktreeId)).toBeNull();
    expect(readFileSync(path.join(foreignCwd, "tracked"), "utf8")).toBe("contents\n");
  } finally { f.close(); }
});

it("retains a lock and schedule without matching Web journal evidence", async () => {
  const f = fixture();
  try {
    f.store.registerProject(f.project);
    f.store.activateTask(f.store.registerPending({ ...f.owner, agent: "codex", agentControlMode: "web" }));
    const database = new Database(path.join(f.root, "state.sqlite"));
    try { database.prepare("INSERT INTO cleanup_schedules(project_id, task_id, claim_id, worktree_id, deadline, failures, next_attempt_at, stage, last_error) VALUES (?, ?, ?, ?, 100, 0, 0, 'observation', NULL)").run(f.owner.projectId, f.owner.taskId, f.owner.claimId, f.owner.worktreeId); } finally { database.close(); }
    await prepareWorkerWorktreeFormat(f);
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).toBeNull();
    expect(readFileSync(path.join(f.cwd, "tracked"), "utf8")).toBe("contents\n");
  } finally { f.close(); }
});

it("retains a same-repository Web journal belonging to another Worker", async () => {
  const f = fixture();
  try {
    const web = openWebExecutionStore(path.join(f.paths.workerDirectory, "web-executions.sqlite"), { onMigration: () => {} });
    const task = web.register({ ...f.owner, project: f.project, serverOrigin: f.serverOrigin, workerId: randomUUID(), userId: f.userId,
      configuration: { agent: "codex", agentControlMode: "web", model: null, args: [], recoveryLimit: 2 } }, 1);
    web.bindWorktree(task, { repositoryPath: f.repo, commonDirectory: f.commonDirectory, worktreePath: f.cwd, branch: `daynight/${f.owner.taskId}` }, 2);
    web.close();
    await prepareWorkerWorktreeFormat(f);
    expect(existsSync(path.join(f.admin, "locked"))).toBe(true);
    expect(createWorktreeManifestStore(f.commonDirectory).read(f.owner.worktreeId)).toBeNull();
  } finally { f.close(); }
});
