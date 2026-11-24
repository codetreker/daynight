import path from "node:path";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterAll, afterEach, expect, it } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { runRepositoryGit } from "../../../src/repository/git.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))) }).trim();
const worktreePaths = (cwd: string): string[] => git(cwd, "worktree", "list", "--porcelain", "-z").split("\0").filter(field => field.startsWith("worktree ")).map(field => path.normalize(field.slice("worktree ".length)));
const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/current-worktrees");
const url = "https://example.com/fixture/project.git";
const seedRoots: string[] = [];
let checkoutSeed: Promise<string> | undefined;
let bareSeed: Promise<string> | undefined;

const createCheckoutSeed = async (): Promise<string> => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "seed-"));
  seedRoots.push(root);
  const repository = path.join(root, "repository");
  await mkdir(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Fixture"); git(repository, "config", "user.email", "fixture@example.com");
  git(repository, "config", "core.autocrlf", "false"); git(repository, "config", "core.eol", "lf");
  await writeFile(path.join(repository, "tracked.txt"), "original\n");
  git(repository, "add", "tracked.txt");
  git(repository, "-c", "maintenance.auto=false", "-c", "gc.auto=0", "commit", "-m", "fixture");
  git(repository, "remote", "add", "origin", url);
  return repository;
};

const createBareSeed = async (checkout: string): Promise<string> => {
  const root = path.dirname(checkout);
  const bare = path.join(root, "origin.git");
  git(root, "clone", "--bare", "--no-hardlinks", checkout, bare);
  git(bare, "remote", "remove", "origin");
  return bare;
};

const fixture = async (kind: "checkout" | "checkout-and-origin" = "checkout-and-origin") => {
  const checkout = await (checkoutSeed ??= createCheckoutSeed());
  const root = await mkdtemp(path.join(scratch, "repo-"));
  roots.push(root);
  const repository = path.join(root, "repository");
  const remote = path.join(root, "origin.git");
  const copyOptions = { recursive: true, force: false, errorOnExist: true };
  cpSync(checkout, repository, copyOptions);
  if (kind === "checkout-and-origin") cpSync(await (bareSeed ??= createBareSeed(checkout)), remote, copyOptions);
  // An unexpected fetch in a checkout-only case fails at a private local path.
  git(repository, "config", `url.${remote}.insteadOf`, url);
  const project = { projectId: randomUUID(), repoUrl: url, localPath: repository };
  const owner = { projectId: project.projectId, taskId: randomUUID(), claimId: randomUUID(), worktreeId: randomUUID() };
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(root, "temp") });
  return { root, repository, project, owner, adapter };
};
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
afterAll(async () => {
  await Promise.allSettled([checkoutSeed, bareSeed]);
  await Promise.all(seedRoots.map(root => rm(root, { force: true, recursive: true })));
});

// Real Git setup and repository inspection use multiple subprocesses on every platform.
it("creates and removes an unlocked Git worktree without writing ownership metadata", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/repository has not been prepared/);
    const repository = await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    expect(binding.worktreePath).toBe(path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId));
    expect(binding.branch).toBe(`daynight/${f.owner.taskId}`);
    expect(git(f.repository, "worktree", "list", "--porcelain")).not.toContain("locked");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(await f.adapter.resolveWorktreeBinding(f.project, f.owner, operation)).toEqual(binding);
    expect(await f.adapter.listWorktrees(f.project, operation)).toEqual([{ taskId: f.owner.taskId, binding }]);
    await f.adapter.removeWorktree(f.project, f.owner, operation);
    expect(await f.adapter.findWorktree(f.project, f.owner, operation)).toBeNull();
    expect(await f.adapter.listWorktrees(f.project, operation)).toEqual([]);
    await expect(lstat(path.join(repository.commonDirectory, "daynight", "worktrees"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(f.repository, "show-ref", "--verify", `refs/heads/${binding.branch}`)).toContain(`refs/heads/${binding.branch}`);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("uses an explicitly retained taskId directory without rewriting the existing checkout", async () => {
  const f = await fixture("checkout"), operation = createOperation();
  try {
    const old = path.join(f.repository, ".worktrees", "daynight", f.owner.taskId);
    await mkdir(path.dirname(old), { recursive: true });
    git(f.repository, "worktree", "add", "-b", `daynight/${f.owner.taskId}`, old, "HEAD");
    const before = await readFile(path.join(old, ".git"));
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.verifyWorktree(f.project, f.owner, operation, old);
    expect(binding.worktreePath).toBe(old);
    expect(await f.adapter.listWorktrees(f.project, operation)).toEqual([{ taskId: f.owner.taskId, binding }]);
    expect(await readFile(path.join(old, ".git"))).toEqual(before);
    await f.adapter.removeWorktree(f.project, f.owner, { originalCwd: old });
    expect(await f.adapter.findWorktree(f.project, f.owner, operation, old)).toBeNull();
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("confirms missing paths and retains nonempty unregistered content", async () => {
  const f = await fixture("checkout"), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    await expect(f.adapter.removeWorktree(f.project, f.owner, operation)).resolves.toEqual({ kind: "absent", effectErrors: [] });
    expect(await f.adapter.findWorktree(f.project, f.owner, operation)).toBeNull();
    const leaf = path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId);
    await mkdir(leaf, { recursive: true }); await writeFile(path.join(leaf, "important"), "keep");
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/no matching Git registration/);
    expect(await readFile(path.join(leaf, "important"), "utf8")).toBe("keep");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("restores a missing checkout and stale registration from its original branch", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const commit = git(binding.worktreePath, "rev-parse", "HEAD");
    await rm(binding.worktreePath, { recursive: true });
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath)).toEqual(binding);
    expect(git(binding.worktreePath, "rev-parse", "HEAD")).toBe(commit);
    expect(git(binding.worktreePath, "branch", "--show-current")).toBe(binding.branch);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
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
    expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, binding.worktreePath, true)).toEqual(binding);
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("restores a checkout at its exact retained legacy binding", async () => {
  const f = await fixture("checkout"), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const legacy = path.join(f.repository, ".worktrees", "daynight", f.owner.taskId);
    git(f.repository, "branch", `daynight/${f.owner.taskId}`);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation, legacy);
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/already checked out/);
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, legacy)).toEqual(binding);
    git(f.repository, "worktree", "remove", binding.worktreePath);
    expect(await f.adapter.prepareWorktree(f.project, f.owner, operation, legacy)).toEqual(binding);
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
  const f = await fixture("checkout"), operation = createOperation();
  try {
    const repository = await f.adapter.prepareRepository(f.project, operation);
    git(f.repository, "branch", `daynight/${f.owner.taskId}`);
    const cwd = path.join(f.repository, ".worktrees", "daynight", f.owner.worktreeId);
    const binding = { repositoryPath: f.repository, commonDirectory: repository.commonDirectory, worktreePath: cwd, branch: `daynight/${f.owner.taskId}` };
    await expect(f.adapter.prepareWorktree(f.project, f.owner, operation, cwd, true, { ...binding, commonDirectory: f.root })).rejects.toThrow(/binding differs/);
    expect(await f.adapter.resolveWorktreeBinding(f.project, f.owner, operation)).toBeNull();
    expect(worktreePaths(f.repository)).not.toContain(path.normalize(cwd));
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("ignores an orphaned ownership file after checkout and registration removal", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const repo = await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const oldRecords = path.join(repo.commonDirectory, "daynight", "worktrees");
    await mkdir(oldRecords, { recursive: true });
    const oldRecord = path.join(oldRecords, `${f.owner.worktreeId}.json`);
    const bytes = JSON.stringify({ schemaVersion: 1, ...f.owner, directoryName: f.owner.worktreeId });
    await writeFile(oldRecord, bytes);
    git(f.repository, "worktree", "remove", binding.worktreePath);
    expect(await f.adapter.listWorktrees(f.project, operation)).toEqual([]);
    expect(await f.adapter.findWorktree(f.project, f.owner, operation)).toBeNull();
    expect(await readFile(oldRecord, "utf8")).toBe(bytes);
    const replacement = { ...f.owner, claimId: randomUUID(), worktreeId: randomUUID() };
    expect((await f.adapter.prepareWorktree(f.project, replacement, operation)).branch).toBe(binding.branch);
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

it("serializes concurrent repository preparation and leaves a failed gate closed", async () => {
  const f = await fixture("checkout"), operation = createOperation();
  let release!: () => void, entered!: () => void, calls = 0;
  const start = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-gate"), runGit: async (cwd, args, op, options) => {
    if (args.includes("--is-bare-repository") && ++calls === 1) { entered(); await barrier; throw new Error("inspection failed"); }
    return runRepositoryGit(cwd, args, op, options);
  } });
  try {
    const first = adapter.prepareRepository(f.project, operation);
    await start;
    const second = adapter.prepareRepository(f.project, operation);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/repository has not been prepared/);
    release();
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.every(value => value.status === "rejected")).toBe(true);
    expect(calls).toBe(2);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation)).rejects.toThrow(/repository has not been prepared/);
  } finally { release(); operation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("keeps a prepared repository available while another caller repeats preparation", async () => {
  const f = await fixture("checkout"), operation = createOperation();
  let release!: () => void, entered!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-repeat"), runGit: async (cwd, args, op, options) => {
    if (args.includes("--is-bare-repository") && ++calls === 2) { entered(); await barrier; }
    return runRepositoryGit(cwd, args, op, options);
  } });
  try {
    await adapter.prepareRepository(f.project, operation);
    const repeated = adapter.prepareRepository(f.project, operation);
    await started;
    expect((await adapter.scanWorktrees(f.project, operation)).unknown).toEqual([]);
    release(); await repeated;
    expect((await adapter.scanWorktrees(f.project, operation)).unknown).toEqual([]);
  } finally { release(); operation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("does not reuse a prepared gate for a different project binding", async () => {
  const f = await fixture("checkout"), operation = createOperation();
  const adapter = f.adapter;
  try {
    await adapter.prepareRepository(f.project, operation);
    const different = { ...f.project, projectId: randomUUID() };
    await adapter.prepareRepository(different, operation);
    expect((await adapter.scanWorktrees(f.project, operation)).unknown[0]?.error).toMatchObject({ message: expect.stringContaining("repository has not been prepared") });
    expect((await adapter.scanWorktrees(different, operation)).unknown).toEqual([]);
  } finally { operation.dispose(); await adapter.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("keeps the original preparation alive when a joined caller is canceled", async () => {
  const f = await fixture("checkout"), firstOperation = createOperation();
  const cancellation = new AbortController(), secondOperation = createOperation({ signal: cancellation.signal });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(f.root, "temp-joined"), runGit: async (cwd, args, op, options) => {
    if (args.includes("--is-bare-repository")) { entered(); await barrier; }
    return runRepositoryGit(cwd, args, op, options);
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
    await f.adapter.removeUnregisteredReservation(f.project, f.owner, operation);
    const { lstat } = await import("node:fs/promises");
    await expect(lstat(leaf)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(leaf); await writeFile(path.join(leaf, "keep"), "unknown");
    await expect(f.adapter.removeUnregisteredReservation(f.project, f.owner, operation)).rejects.toThrow(/not empty/);
    expect(await readFile(path.join(leaf, "keep"), "utf8")).toBe("unknown");
    await rm(path.join(leaf, "keep"));
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    await expect(f.adapter.removeUnregisteredReservation(f.project, f.owner, operation)).rejects.toThrow(/still has a Git worktree registration/);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);
