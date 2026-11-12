import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))) }).trim();
const emptySources = { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] };
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/current-worktrees");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "repo-")); roots.push(root);
  const repository = path.join(root, "repository"); await mkdir(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Fixture"); git(repository, "config", "user.email", "fixture@example.com");
  git(repository, "config", "core.autocrlf", "false"); git(repository, "config", "core.eol", "lf");
  await writeFile(path.join(repository, "tracked.txt"), "original\n");
  git(repository, "add", "tracked.txt"); git(repository, "commit", "-m", "fixture");
  const remote = path.join(root, "origin.git"); git(root, "clone", "--bare", repository, remote);
  const url = "https://example.com/fixture/project.git";
  git(repository, "remote", "add", "origin", url); git(repository, "config", `url.${remote}.insteadOf`, url);
  const project = { projectId: randomUUID(), repoUrl: url, localPath: repository };
  const owner = { projectId: project.projectId, taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(root, "temp"), prepareFormat: async (_project, repo, operation) => { await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation, sources: emptySources }); } });
  return { root, repository, project, owner, adapter };
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });

// Real Git setup and repository inspection use multiple subprocesses on every platform.
it("gates current worktrees until real migration, creates unlocked worktree, and retires only metadata after deletion", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/format has not been prepared/);
    const repository = await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    expect(binding.worktreePath).toBe(path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId));
    expect(binding.branch).toBe(`daynight/${f.owner.taskId}`);
    expect(git(f.repository, "worktree", "list", "--porcelain")).not.toContain("locked");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await f.adapter.resolveWorktreeBinding(f.project, f.owner, operation)).toEqual(binding);
    expect(await f.adapter.listWorktrees(f.project, operation)).toEqual([{ owner: f.owner, binding }]);
    await f.adapter.removeWorktree(f.project, f.owner, operation);
    expect(await f.adapter.findWorktree(f.project, f.owner, operation)).toBeNull();
    expect(await f.adapter.listWorktrees(f.project, operation)).toEqual([]);
    expect(await f.adapter.listWorktreeManifests(f.project, operation)).toEqual([{ owner: f.owner, binding }]);
    expect(createWorktreeManifestStore(repository.commonDirectory).read(f.owner.worktreeId)).not.toBeNull();
    await f.adapter.retireWorktreeManifest(f.project, f.owner, operation);
    expect(createWorktreeManifestStore(repository.commonDirectory).read(f.owner.worktreeId)).toBeNull();
    expect(git(f.repository, "show-ref", "--verify", `refs/heads/${binding.branch}`)).toContain(`refs/heads/${binding.branch}`);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("uses a migrated taskId directory without rewriting the existing checkout", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const old = path.join(f.repository, ".worktrees", "daynight", f.owner.taskId);
    await mkdir(path.dirname(old), { recursive: true });
    const marker = `daynight-worker:${JSON.stringify({ ...f.owner, leaf: "1:1", root: "1:1", common: "1:1" })}`;
    git(f.repository, "worktree", "add", "--lock", "--reason", marker, "-b", `daynight/${f.owner.taskId}`, old, "HEAD");
    const before = await readFile(path.join(old, ".git"));
    const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-migration"), prepareFormat: async (_project, repo, op) => {
      await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation: op,
        sources: { ...emptySources, listSchedules: () => [f.owner] } });
    } });
    try {
      await adapter.prepareRepository(f.project, operation);
      const binding = await adapter.verifyWorktree(f.project, f.owner, operation);
      expect(binding.worktreePath).toBe(old);
      expect(await readFile(path.join(old, ".git"))).toEqual(before);
      expect(git(f.repository, "worktree", "list", "--porcelain")).not.toContain("locked");
      await adapter.removeWorktree(f.project, f.owner, operation);
      await adapter.retireWorktreeManifest(f.project, f.owner, operation);
    } finally { await adapter.dispose(); }
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("retains unknown content and never treats a missing manifest as proof of absence", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    await expect(f.adapter.removeWorktree(f.project, f.owner, operation)).rejects.toThrow(/manifest is missing/);
    await expect(f.adapter.findWorktree(f.project, f.owner, operation)).rejects.toThrow(/manifest is missing/);
    const leaf = path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId);
    await mkdir(leaf, { recursive: true }); await writeFile(path.join(leaf, "important"), "keep");
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/no matching Git registration/);
    expect(await readFile(path.join(leaf, "important"), "utf8")).toBe("keep");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("restores a missing checkout and stale registration from its original branch", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const repository = await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const commit = git(binding.worktreePath, "rev-parse", "HEAD");
    await rm(binding.worktreePath, { recursive: true });
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath)).toEqual(binding);
    expect(git(binding.worktreePath, "rev-parse", "HEAD")).toBe(commit);
    expect(git(binding.worktreePath, "branch", "--show-current")).toBe(binding.branch);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    const store = createWorktreeManifestStore(repository.commonDirectory);
    store.remove(store.read(f.owner.worktreeId)!);
    await rm(binding.worktreePath, { recursive: true });
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation)).toEqual(binding);
    expect(git(binding.worktreePath, "rev-parse", "HEAD")).toBe(commit);
    expect(store.read(f.owner.worktreeId)).not.toBeNull();
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("does not restore a checkout that disappears after a live execution was observed", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    await rm(path.join(f.repository, ".worktrees"), { recursive: true });
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath, true, undefined, false)).rejects.toThrow(/may still be running/);
    await expect(lstat(path.join(f.repository, ".worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(f.repository, "worktree", "list", "--porcelain")).toContain(binding.worktreePath);
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath, true)).toEqual(binding);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("restores a missing manifest from the exact retained legacy binding", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const repository = await f.adapter.prepareRepository(f.project, operation);
    const legacy = path.join(f.repository, ".worktrees", "daynight", f.owner.taskId);
    const store = createWorktreeManifestStore(repository.commonDirectory);
    store.publish({ schemaVersion: 1, ...f.owner, directoryName: f.owner.taskId });
    git(f.repository, "branch", `daynight/${f.owner.taskId}`);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation, legacy);
    const original = store.read(f.owner.worktreeId)!;
    store.remove(original);
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/already checked out/);
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, legacy)).toEqual(binding);
    expect(store.read(f.owner.worktreeId)).toEqual(original);
    git(f.repository, "worktree", "remove", binding.worktreePath);
    store.remove(original);
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, legacy)).toEqual(binding);
    expect(store.read(f.owner.worktreeId)).toEqual(original);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("does not replace a missing original branch or overwrite an unregistered directory", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    git(f.repository, "worktree", "remove", binding.worktreePath);
    git(f.repository, "branch", "-D", binding.branch);
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath, true)).rejects.toThrow(/original task branch is missing/);
    await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "keep");
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath)).rejects.toThrow(/no matching Git registration/);
    expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("keep");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("rejects a conflicting retained binding before creating a checkout", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const repository = await f.adapter.prepareRepository(f.project, operation);
    git(f.repository, "branch", `daynight/${f.owner.taskId}`);
    const cwd = path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId);
    const binding = { repositoryPath: f.repository, commonDirectory: repository.commonDirectory, worktreePath: cwd, branch: `daynight/${f.owner.taskId}` };
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation, cwd, true, { ...binding, commonDirectory: f.root })).rejects.toThrow(/binding differs/);
    expect(await f.adapter.resolveWorktreeBinding(f.project, f.owner, operation)).toBeNull();
    expect(git(f.repository, "worktree", "list", "--porcelain")).not.toContain(cwd);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("retires an already settled manifest without touching a later occupant", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const repo = await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    await f.adapter.removeWorktree(f.project, f.owner, operation);
    await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "successor"), "keep");
    await f.adapter.retireWorktreeManifest(f.project, f.owner, operation);
    expect(await readFile(path.join(binding.worktreePath, "successor"), "utf8")).toBe("keep");
    expect(createWorktreeManifestStore(repo.commonDirectory).read(f.owner.worktreeId)).toBeNull();
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it.each(["reverse", "common", "missing-pointer", "duplicate"]) ("retains a worktree with %s registration damage", async damage => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const admin = git(binding.worktreePath, "rev-parse", "--absolute-git-dir");
    const tracked = path.join(binding.worktreePath, "tracked.txt"), original = await readFile(tracked);
    const pointer = path.join(binding.worktreePath, ".git");
    if (damage === "reverse") { await rm(pointer); await writeFile(pointer, "gitdir: /foreign\n"); }
    if (damage === "common") await writeFile(path.join(admin, "commondir"), f.root);
    if (damage === "missing-pointer") await rm(path.join(binding.worktreePath, ".git"));
    if (damage === "duplicate") {
      const { cp } = await import("node:fs/promises");
      await cp(admin, path.join(path.dirname(admin), "duplicate"), { recursive: true });
    }
    await expect(f.adapter.removeWorktree(f.project, f.owner, operation)).rejects.toThrow();
    expect(await readFile(tracked)).toEqual(original);
    if (damage === "reverse") expect(await readFile(pointer, "utf8")).toBe("gitdir: /foreign\n");
    const scan = await f.adapter.scanWorktrees(f.project, operation);
    expect(scan.quarantined.length + scan.unknown.length).toBeGreaterThan(0);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("serializes concurrent repository format preparation and leaves a failed gate closed", async () => {
  const f = await fixture(), operation = createOperation();
  let release!: () => void, entered!: () => void, calls = 0;
  const start = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-gate"), prepareFormat: async () => { calls++; entered(); await barrier; throw new Error("format failure"); } });
  try {
    const first = adapter.prepareRepository(f.project, operation);
    await start;
    const second = adapter.prepareRepository(f.project, operation);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/format has not been prepared/);
    release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every(value => value.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/format has not been prepared/);
  } finally { release(); operation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("keeps a prepared repository available while another caller repeats preparation", async () => {
  const f = await fixture(), operation = createOperation();
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-repeat"), prepareFormat: async (_project, repo, scoped) => {
    calls++;
    if (calls > 1) { entered(); await barrier; }
    await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation: scoped, sources: emptySources });
  } });
  try {
    await adapter.prepareRepository(f.project, operation);
    const repeated = adapter.prepareRepository(f.project, operation);
    const repeatedHookStarted = await Promise.race([started.then(() => true), repeated.then(() => false)]);
    if (repeatedHookStarted) {
      const scan = await adapter.scanWorktrees(f.project, operation);
      expect(scan.unknown).toEqual([]);
    }
    release(); await repeated;
    expect(calls).toBe(1);
    expect((await adapter.scanWorktrees(f.project, operation)).unknown).toEqual([]);
  } finally { release(); operation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("does not reuse a prepared gate for a different project binding", async () => {
  const f = await fixture(), operation = createOperation();
  let calls = 0;
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-mapping"), prepareFormat: async (_project, repo, scoped) => {
    calls++;
    await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation: scoped, sources: emptySources });
  } });
  try {
    await adapter.prepareRepository(f.project, operation);
    const different = { ...f.project, projectId: randomUUID() };
    await adapter.prepareRepository(different, operation);
    expect(calls).toBe(2);
    expect((await adapter.scanWorktrees(f.project, operation)).unknown[0]?.error).toMatchObject({ message: expect.stringContaining("format has not been prepared") });
    expect((await adapter.scanWorktrees(different, operation)).unknown).toEqual([]);
  } finally { operation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("keeps the original preparation alive when a joined caller is canceled", async () => {
  const f = await fixture(), firstOperation = createOperation();
  const cancellation = new AbortController(), secondOperation = createOperation({ signal: cancellation.signal });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-joined"), prepareFormat: async (_project, repo, scoped) => {
    entered(); await barrier;
    await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation: scoped, sources: emptySources });
  } });
  try {
    const first = adapter.prepareRepository(f.project, firstOperation);
    await started;
    const second = adapter.prepareRepository(f.project, secondOperation);
    await new Promise<void>(resolve => setImmediate(resolve));
    const reason = new Error("joined caller canceled");
    cancellation.abort(reason);
    release();
    await first;
    await expect(second).rejects.toMatchObject({ kind: "cancelled", cause: reason });
    expect((await adapter.scanWorktrees(f.project, firstOperation)).unknown).toEqual([]);
  } finally { release(); firstOperation.dispose(); secondOperation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("settles only the exact empty unpublished reservation", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const leaf = path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId);
    await mkdir(leaf, { recursive: true });
    await f.adapter.removeUnpublishedReservation(f.project, f.owner, operation);
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(leaf)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(leaf); await writeFile(path.join(leaf, "keep"), "unknown");
    await expect(f.adapter.removeUnpublishedReservation(f.project, f.owner, operation)).rejects.toThrow(/not empty/);
    expect(await readFile(path.join(leaf, "keep"), "utf8")).toBe("unknown");
    await rm(path.join(leaf, "keep"));
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    await expect(f.adapter.removeUnpublishedReservation(f.project, f.owner, operation)).rejects.toThrow(/published manifest/);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);
