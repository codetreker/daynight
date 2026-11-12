import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync, type ChildProcess } from "node:child_process";
import { cpSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { runRepositoryGit } from "../../../src/repository/git.js";
import { RepositoryGitCleanupPendingError, startOwnedRepositoryGit, type GitSettlement, type OwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import type { ResourceOwner, WorkerProject } from "../../../src/commands/worker/types.js";

// The selected mutation runs in a real subprocess with one inherited pipe held
// by a real descendant. Other Git calls still use the actual executable.
const controlledGit = vi.hoisted(() => ({ command: "", script: undefined as string | undefined, child: undefined as ChildProcess | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const words = Array.isArray(args[1]) ? args[1] : [];
    if (args[0] === "git" && controlledGit.script !== undefined && words.includes(controlledGit.command)) {
      const child = actual.spawn(process.execPath, [controlledGit.script], args[2]);
      controlledGit.child = child;
      return child;
    }
    return Reflect.apply(actual.spawn, undefined, args) as ReturnType<typeof actual.spawn>;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const cleanupBoundary = vi.hoisted(() => ({ afterSuccess: undefined as (() => void) | undefined }));
vi.mock("../../../src/commands/cleanup-operation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/commands/cleanup-operation.js")>();
  return { ...actual, cleanupOperation: async <T>(...args: Parameters<typeof actual.cleanupOperation>): Promise<T> => {
    const result = await actual.cleanupOperation(...args);
    cleanupBoundary.afterSuccess?.();
    return result as T;
  } };
});

const registrationBoundary = vi.hoisted(() => ({ afterRead: undefined as (() => void) | undefined }));
vi.mock("../../../src/commands/worker/worktree-scan.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../src/commands/worker/worktree-scan.js")>();
  return { ...actual, registrationsFor: async (...args: Parameters<typeof actual.registrationsFor>) => {
    const result = await actual.registrationsFor(...args);
    registrationBoundary.afterRead?.();
    return result;
  } };
});

const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-git-tests");
type RefFormat = "files" | "reftable";
let seedRoot: string | undefined;
const seeds = new Map<RefFormat, Promise<string>>();
const directories: string[] = [];
const managers: ReturnType<typeof createWorkerGitManager>[] = [];
const operations: Operation[] = [];
const pendingReservations = new Set<Promise<unknown>>();
const reservation = <T>(pending: Promise<T>): Promise<T> => {
  pendingReservations.add(pending);
  void pending.then(() => pendingReservations.delete(pending), () => pendingReservations.delete(pending));
  return pending;
};
const env = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: env(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
const operation = (): Operation => { const result = createOperation(); operations.push(result); return result; };
const manager = (root: string, options: Partial<Parameters<typeof createWorkerGitManager>[0]> = {}) => {
  const raw = createWorkerGitManager({ temporaryDirectory: path.join(root, "temporary"), prepareFormat: async (_project, repo, op) => {
    await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation: op,
      sources: { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] } });
  }, ...options });
  const prepared = new Map<string, string>();
  const pathKey = (project: WorkerProject) => path.normalize(project.localPath);
  const bindingKey = (project: WorkerProject) => JSON.stringify([project.projectId, project.repoUrl]);
  const prepare = async (project: WorkerProject, op: Operation) => {
    const key = pathKey(project);
    prepared.delete(key);
    const repository = await raw.prepareRepository(project, op);
    prepared.set(key, bindingKey(project));
    return repository;
  };
  const result = new Proxy(raw, { get(target, property) {
    const value = Reflect.get(target, property) as unknown;
    if (typeof value !== "function" || property === "dispose") return value;
    if (property === "prepareRepository") return prepare;
    return async (project: WorkerProject, ...args: unknown[]) => {
      if (prepared.get(pathKey(project)) !== bindingKey(project)) {
        if (property === "scanWorktrees" || property === "listWorktrees") {
          const entry = await lstat(project.localPath).catch(() => null);
          if (entry === null || entry.isSymbolicLink()) return Reflect.apply(value, target, [project, ...args]);
        }
        const op = createOperation();
        try { await prepare(project, op); } finally { op.dispose(); }
      }
      return Reflect.apply(value, target, [project, ...args]);
    };
  } });
  managers.push(result); return result;
};
// Legacy fault-injection cases control the command result after the bounded test runner settles.
// Separate lifecycle tests below exercise the actual owned Git port.
const ownedRunner = (runner: typeof runRepositoryGit): typeof startOwnedRepositoryGit => (cwd, args, op, options) => {
  const result = Promise.resolve().then(() => runner(cwd, args, op, options));
  const joined: OwnedRepositoryGit["joined"] = result.then(() => ({ kind: "local-closed", cleanupErrors: [] }), () => ({ kind: "local-closed", cleanupErrors: [] }));
  return { outcome: result.then(value => ({ kind: "success", result: value }), error => ({ kind: "failure", error, settlement: "joined" })), joined, requestStop: () => {} };
};
const errorText = (value: unknown): string => value instanceof Error
  ? [value.message, value.cause === undefined ? "" : errorText(value.cause), ...(value instanceof AggregateError ? value.errors.map(errorText) : [])].join(" ")
  : String(value);
const remote = "https://example.com/organization/repository.git";
const ids = { projectId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", claimId: "33333333-3333-4333-8333-333333333333", workerId: "44444444-4444-4444-8444-444444444444", worktreeId: "55555555-5555-4555-8555-555555555555" };
const prepareSeed = async (refFormat: RefFormat): Promise<string> => {
  const repository = path.join(seedRoot!, refFormat); await mkdir(repository);
  git(repository, ["init", "--initial-branch=main", ...(refFormat === "reftable" ? ["--ref-format=reftable"] : [])]);
  git(repository, ["config", "user.name", "Fixture"]); git(repository, ["config", "user.email", "fixture@example.com"]);
  // Checkout bytes remain stable under native core.autocrlf settings; dirty-work assertions stay exact.
  await writeFile(path.join(repository, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(repository, "tracked.txt"), "original\n"); git(repository, ["add", ".gitattributes", "tracked.txt"]); git(repository, ["commit", "-m", "fixture"]);
  git(repository, ["remote", "add", "origin", remote]);
  return repository;
};
const seed = (refFormat: RefFormat): Promise<string> => {
  const existing = seeds.get(refFormat);
  if (existing !== undefined) return existing;
  const preparation = prepareSeed(refFormat); seeds.set(refFormat, preparation); return preparation;
};
const fixture = async (refFormat: RefFormat = "files") => {
  const source = await seed(refFormat);
  const root = await mkdtemp(path.join(scratch, "Git 用户 ")); directories.push(root);
  const repository = path.join(root, "repository");
  cpSync(source, repository, { recursive: true, force: false, errorOnExist: true });
  const bare = path.join(root, "origin.git");
  git(root, ["clone", "--bare", repository, bare]);
  git(repository, ["config", `url.${bare}.insteadOf`, remote]);
  const project: WorkerProject = { projectId: ids.projectId, repoUrl: remote, localPath: repository };
  const owner: ResourceOwner = { projectId: ids.projectId, taskId: ids.taskId, claimId: ids.claimId, worktreeId: ids.worktreeId };
  return { root, repository, bare, project, owner };
};
const administrativeDirectory = (cwd: string): string => git(cwd, ["rev-parse", "--absolute-git-dir"]);
const worktreePaths = (cwd: string): string[] => git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((field) => field.startsWith("worktree ")).map((field) => path.normalize(field.slice(9)));
const privateBases = (cwd: string): string => git(cwd, ["for-each-ref", "--format=%(refname)", "refs/daynight/worker-bases/"]);
const commitForOrigin = (repository: string, bare: string, branch: string, message: string): string => {
  const commit = git(repository, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", message]);
  git(bare, ["fetch", "--no-write-fetch-head", "--no-tags", "--no-auto-maintenance", repository, `${commit}:refs/heads/${branch}`]);
  return commit;
};
const changedClaim = (owner: ResourceOwner): ResourceOwner => ({ ...owner, claimId: "66666666-6666-4666-8666-666666666666", worktreeId: "77777777-7777-4777-8777-777777777777" });
beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
  seedRoot = await mkdtemp(path.join(scratch, "Immutable seeds "));
});
afterAll(async () => {
  await Promise.allSettled(seeds.values());
  if (seedRoot !== undefined) await rm(seedRoot, { recursive: true, force: true });
});
afterEach(async () => {
  controlledGit.command = ""; controlledGit.script = undefined; controlledGit.child = undefined; cleanupBoundary.afterSuccess = undefined; registrationBoundary.afterRead = undefined;
  vi.unstubAllEnvs();
  operations.splice(0).forEach((entry) => entry.dispose());
  await Promise.allSettled([...pendingReservations]);
  await Promise.all(managers.splice(0).map((entry) => entry.dispose()));
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("worker repositories and task worktrees", { timeout: 30_000 }, () => {
  it.each(["files", "reftable"] as const)("keeps %s seed and sibling bytes, refs and objects independent of a case copy", async (refFormat) => {
    const first = await fixture(refFormat); const sibling = await fixture(refFormat); const source = await seed(refFormat);
    const head = git(first.repository, ["rev-parse", "HEAD"]);
    const originalObject = git(source, ["cat-file", "-p", head]);
    const objectPath = path.join(".git", "objects", head.slice(0, 2), head.slice(2));
    await writeFile(path.join(first.repository, "tracked.txt"), "private case bytes\n");
    git(first.repository, ["update-ref", "refs/heads/private-case", head]);
    await chmod(path.join(first.repository, objectPath), 0o644);
    await writeFile(path.join(first.repository, objectPath), "private corrupted object\n");
    expect(() => git(first.repository, ["cat-file", "-p", head])).toThrow();
    for (const repository of [sibling.repository, source]) {
      expect(await readFile(path.join(repository, "tracked.txt"), "utf8")).toBe("original\n");
      expect(git(repository, ["rev-parse", "HEAD"])).toBe(head);
      expect(git(repository, ["for-each-ref", "--format=%(refname)", "refs/heads/private-case"])).toBe("");
      expect(git(repository, ["cat-file", "-p", head])).toBe(originalObject);
    }
  });

  it("finds an owned worktree after a lost binding without creating or resetting one", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    await expect(adapter.findWorktree(f.project, f.owner, operation())).rejects.toThrow("manifest is missing");
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await writeFile(path.join(binding.worktreePath, "tracked.txt"), "retained dirty work\n");
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("retained dirty work\n");
    await expect(adapter.findWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("manifest is missing");
  });

  it("inspects linked metadata from the repository cwd with its original absolute context and operation budget", async () => {
    const f = await fixture();
    const calls: { cwd: string; args: readonly string[]; op: Operation; timeoutMs: number | undefined }[] = [];
    let inspect = false;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (inspect && args.some(arg => arg.startsWith("--work-tree="))) {
        calls.push({ cwd, args, op, timeoutMs: options?.timeoutMs });
        if (args.includes("--git-common-dir")) return { ...result, stdout: `${path.relative(cwd, result.stdout.trim())}\n` };
      }
      return result;
    } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const admin = await realpath(administrativeDirectory(binding.worktreePath));
    const op = createOperation({ limits: { totalMs: 60_000, requestMs: 12_345 } }); operations.push(op);
    const remaining = op.remainingMs();
    inspect = true;
    await expect(adapter.verifyWorktree(f.project, f.owner, op)).resolves.toEqual(binding);
    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.args.slice(-3))).toEqual([
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      ["config", "--get-all", "remote.origin.url"],
    ]);
    for (const call of calls) {
      expect(call.cwd).toBe(f.repository);
      expect(call.args).toContain(`--git-dir=${admin}`);
      expect(call.args).toContain(`--work-tree=${binding.worktreePath}`);
      expect(call.args).not.toContain("-C");
      expect(call.op.limits).toBe(op.limits);
      expect(call.op.remainingMs()).toBeLessThanOrEqual(remaining);
      expect(call.timeoutMs).toBe(12_345);
    }
  });

  it.each(["--git-common-dir", "remote.origin.url"])("retains the original %s inspection error and unknown inventory", async command => {
    const f = await fixture(); const failure = new Error("metadata query failed"); let inspect = false;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (inspect && args.some(arg => arg.startsWith("--work-tree=")) && args.includes(command)) throw failure;
      return runRepositoryGit(cwd, args, op, options);
    } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const pointer = await readFile(path.join(binding.worktreePath, ".git"), "utf8");
    inspect = true;
    await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toBe(failure);
    const scan = await adapter.scanWorktrees(f.project, operation());
    expect(scan.validated).toEqual([]);
    expect(scan.quarantined).toEqual([]);
    expect(scan.unknown).toEqual([{ error: failure }]);
    expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toBe(pointer);
  });

  it("finds cleanup worktrees read-only and rejects an unattributed present path", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId); await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep");
    await expect(adapter.findWorktree(f.project, f.owner, operation())).rejects.toThrow("manifest is missing");
    expect(await readFile(path.join(target, "unrelated"), "utf8")).toBe("keep");
  });

  it("finds no claim resources in a repository without managed worktrees", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
  });

  it("can inspect managed worktrees belonging to another Project in the same repository", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const foreignProject = { ...f.project, projectId: "99999999-9999-4999-8999-999999999999" };
    const foreignOwner = { ...f.owner, projectId: foreignProject.projectId };
    const binding = await adapter.prepareWorktree(foreignProject, foreignOwner, operation());
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    expect(await adapter.listWorktrees(f.project, operation(), false, true)).toEqual([{ owner: foreignOwner, binding }]);
  });

  it("only treats an absent repository as empty when explicitly requested, rejecting a dangling link", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const absent = { ...f.project, localPath: path.join(f.root, "missing", "repo") };
    await expect(adapter.listWorktrees(absent, operation())).rejects.toThrow("missing");
    await expect(adapter.listWorktrees(absent, operation(), true)).resolves.toEqual([]);
    const dangling = path.join(f.root, "dangling"); await symlink(path.join(f.root, "missing"), dangling);
    await expect(adapter.listWorktrees({ ...f.project, localPath: dangling }, operation(), true)).rejects.toThrow(/symbolic link/);
  });

  describe("claim resource discovery", () => {
    const prepare = async () => {
      const f = await fixture(); const adapter = manager(f.root);
      const first = await adapter.prepareWorktree(f.project, f.owner, operation());
      const otherOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", worktreeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      const second = await adapter.prepareWorktree(f.project, otherOwner, operation());
      const unrelated = path.join(f.root, "unrelated worktree");
      git(f.repository, ["worktree", "add", "--detach", "--lock", "--reason", "unrelated", unrelated, "HEAD"]);
      return { f, adapter, first, otherOwner, second, unrelated };
    };
    let prepared: Awaited<ReturnType<typeof prepare>>;
    beforeEach(async () => { prepared = await prepare(); });

    it("discovers claim resources from Git alone, including registrations whose leaf disappeared", async () => {
      const { f, adapter, first, otherOwner, second, unrelated } = prepared;
      expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding: first }, { owner: otherOwner, binding: second }]);
      await rm(first.worktreePath, { recursive: true });
      expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding: first }, { owner: otherOwner, binding: second }]);
      expect(await adapter.findWorktree(f.project, f.owner, operation())).toEqual(first);
      await adapter.removeWorktree(f.project, f.owner, operation());
      expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: otherOwner, binding: second }]);
      expect(await readFile(path.join(unrelated, "tracked.txt"), "utf8")).toBe("original\n");
    });
  });

  it("discovers owned registrations independently of unregistered task paths", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep\n");
    const healthyOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", worktreeId: "99999999-9999-4999-8999-999999999999" };
    const healthy = await adapter.prepareWorktree(f.project, healthyOwner, operation());
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: healthyOwner, binding: healthy }]);
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("manifest is missing");
    expect(await readFile(path.join(target, "unrelated"), "utf8")).toBe("keep\n");
  });

  it("settles published empty reservations without inferring an absent manifest", async () => {
    const f = await fixture(), adapter = manager(f.root);
    const repository = await adapter.prepareRepository(f.project, operation());
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("manifest is missing");
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    createWorktreeManifestStore(repository.commonDirectory).publish({ schemaVersion: 1, ...f.owner, directoryName: f.owner.worktreeId });
    expect(await adapter.findWorktree(f.project, f.owner, operation())).not.toBeNull();
    await adapter.removeWorktree(f.project, f.owner, operation());
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toBeNull();
  });

  it("cleans only an exact unpublished empty reservation", async () => {
    const f = await fixture(), adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    await adapter.removeUnpublishedReservation(f.project, f.owner, operation());
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(target); await writeFile(path.join(target, "foreign"), "keep\n");
    await expect(adapter.removeUnpublishedReservation(f.project, f.owner, operation())).rejects.toThrow("not empty");
    expect(await readFile(path.join(target, "foreign"), "utf8")).toBe("keep\n");
  });

  it("rejects symlink parents when cleaning a reservation by task identity", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const outside = path.join(f.root, "outside");
    await mkdir(path.join(outside, ids.taskId), { recursive: true });
    await mkdir(path.join(f.repository, ".worktrees"));
    await symlink(outside, path.join(f.repository, ".worktrees", "daynight"));
    await expect(adapter.removeEmptyReservation(f.project, ids.taskId, operation())).rejects.toThrow("ordinary directory");
    expect((await lstat(path.join(outside, ids.taskId))).isDirectory()).toBe(true);
  });



  describe("partial resource scans", () => {
    it.each(["file", "leaf", "component-case"])("fences case-ambiguous missing Git targets: %s", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const owner = { ...f.owner, taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", worktreeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      const binding = await adapter.prepareWorktree(f.project, owner, operation());
      const admin = administrativeDirectory(binding.worktreePath), markerPath = path.join(f.repository, ".git", "daynight", "worktrees", `${owner.worktreeId}.json`), marker = await readFile(markerPath);
      const manual = path.join(f.root, "manual");
      git(f.repository, ["worktree", "add", "--detach", manual, "HEAD"]);
      const pointer = path.join(administrativeDirectory(manual), "gitdir");
      const target = kind === "component-case" ? path.join(path.dirname(binding.worktreePath), owner.worktreeId.toUpperCase(), ".git") : path.join(binding.worktreePath, ".GIT");
      await writeFile(pointer, `${target}\n`);
      git(binding.worktreePath, ["checkout", "-b", "changed-branch"]);
      if (kind === "file") {
        for (const name of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, name), { recursive: true });
      } else await rm(binding.worktreePath, { recursive: true });
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(binding.worktreePath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      const scan = await adapter.scanWorktrees(f.project, operation());
      expect(scan.unknown.length).toBeGreaterThan(0);
      expect(scan.quarantined).toEqual([]);
      git(f.repository, [`--git-dir=${admin}`, "symbolic-ref", "HEAD", `refs/heads/${binding.branch}`]);
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      await expect(adapter.verifyWorktree(f.project, owner, operation())).rejects.toThrow();
      await expect(adapter.removeWorktree(f.project, owner, operation())).rejects.toThrow();
      expect(await readFile(markerPath)).toEqual(marker);
      expect(await readFile(pointer, "utf8")).toBe(`${target}\n`);
    });

    it.each(["absolute", "relative", "missing-parent"])("retains raw traversal in manual registration pointers: %s", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const markerPath = path.join(f.repository, ".git", "daynight", "worktrees", `${f.owner.worktreeId}.json`), marker = await readFile(markerPath);
      const manual = path.join(f.root, "manual");
      git(f.repository, ["worktree", "add", "--detach", manual, "HEAD"]);
      const admin = administrativeDirectory(manual), pointer = path.join(admin, "gitdir");
      const extra = path.join(path.dirname(binding.worktreePath), "extra"), alias = path.join(f.root, "alias");
      await mkdir(extra);
      await symlink(extra, alias, process.platform === "win32" ? "junction" : "dir");
      const start = kind === "relative" ? path.relative(admin, alias) : kind === "missing-parent" ? path.join(f.root, "absent") : alias;
      const raw = `${start}${path.sep}..${path.sep}${f.owner.worktreeId}${path.sep}.git`;
      const absoluteRaw = kind === "relative" ? `${admin}${path.sep}${raw}` : raw;
      if (kind === "missing-parent") await expect(realpath(absoluteRaw)).rejects.toMatchObject({ code: "ENOENT" });
      else if (process.platform === "win32") {
        // Win32 collapses the junction/.. before opening the target. Neither
        // that missing lexical target nor the junction proves safe ownership.
        expect(path.resolve(absoluteRaw)).toBe(path.join(f.root, f.owner.worktreeId, ".git"));
        await expect(realpath(absoluteRaw)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(realpath(path.resolve(absoluteRaw))).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await realpath(absoluteRaw)).toBe(await realpath(path.join(binding.worktreePath, ".git")));
        expect(path.resolve(admin, raw)).not.toBe(await realpath(absoluteRaw));
      }
      await writeFile(pointer, `${raw}\n`);
      git(binding.worktreePath, ["checkout", "-b", "changed-branch"]);
      const scan = await adapter.scanWorktrees(f.project, operation());
      expect(scan.unknown.length).toBeGreaterThan(0);
      expect(scan.quarantined).toEqual([]);
      git(binding.worktreePath, ["checkout", binding.branch]);
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow();
      await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow();
      expect(await readFile(markerPath)).toEqual(marker);
      expect(await readFile(pointer, "utf8")).toBe(`${raw}\n`);
      expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    });

    it.each(["forward", "common", "reverse"])("keeps physical cross-repository %s pointers unknown", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const admin = administrativeDirectory(binding.worktreePath), foreign = path.join(f.root, "foreign");
      git(f.root, ["clone", "--no-hardlinks", f.repository, foreign]);
      const foreignLeaf = path.join(foreign, ".worktrees", "daynight", f.owner.worktreeId);
      git(foreign, ["worktree", "add", "--detach", foreignLeaf, "HEAD"]);
      const extra = path.join(foreign, "extra"), alias = path.join(f.repository, "alias");
      await mkdir(extra); await symlink(extra, alias, process.platform === "win32" ? "junction" : "dir");
      const suffix = kind === "common" ? ".git" : kind === "forward" ? `.worktrees/daynight/${f.owner.worktreeId}/.git` : `.git/worktrees/${path.basename(admin)}`;
      const raw = `${alias}/../${suffix}`;
      const expected = kind === "common" ? path.join(f.repository, ".git") : kind === "forward" ? path.join(binding.worktreePath, ".git") : admin;
      expect(path.resolve(raw)).toBe(path.resolve(expected));
      if (process.platform === "win32") expect(await realpath(raw)).toBe(await realpath(expected));
      else expect(await realpath(raw)).not.toBe(await realpath(expected));
      const metadata = kind === "common" ? path.join(admin, "commondir") : kind === "forward" ? path.join(admin, "gitdir") : path.join(binding.worktreePath, ".git");
      const contents = `${kind === "reverse" ? "gitdir: " : ""}${raw}\n`;
      if (kind === "reverse") await rm(metadata);
      await writeFile(metadata, contents);
      // POSIX traverses the alias into the foreign repository. Win32 collapses
      // it into the original path; neither interpretation proves a safe pointer.
      const scan = await adapter.scanWorktrees(f.project, operation());
      expect(scan.unknown.length).toBeGreaterThan(0);
      expect(scan.quarantined).toEqual([]);
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow();
      await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow();
      expect(await readFile(metadata, "utf8")).toBe(contents);
      expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
      expect(await readFile(path.join(foreignLeaf, "tracked.txt"), "utf8")).toBe("original\n");
    });

    it.each(["present", "missing-leaf"])("accepts provable relative Git metadata with parent traversal: %s", async state => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const admin = administrativeDirectory(binding.worktreePath);
      // Git's registration reader strips a literal '/.git', including on Windows.
      const relative = (base: string, target: string) => path.relative(base, target).split(path.sep).join("/");
      await writeFile(path.join(admin, "gitdir"), `${relative(admin, path.join(binding.worktreePath, ".git"))}\n`);
      await writeFile(path.join(admin, "commondir"), `${relative(admin, path.join(f.repository, ".git"))}\n`);
      const pointer = path.join(binding.worktreePath, ".git");
      await rm(pointer);
      await writeFile(pointer, `gitdir: ${relative(binding.worktreePath, admin)}\n`);
      expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
      if (state === "missing-leaf") await rm(binding.worktreePath, { recursive: true });
      expect(await adapter.scanWorktrees(f.project, operation())).toEqual({ enumerationComplete: true, validated: [{ owner: f.owner, binding }], quarantined: [], unknown: [] });
      if (state === "present") await expect(adapter.verifyWorktree(f.project, f.owner, operation())).resolves.toEqual(binding);
      else await expect(adapter.findWorktree(f.project, f.owner, operation())).resolves.toEqual(binding);
      await adapter.removeWorktree(f.project, f.owner, operation());
      await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["case-alias", "hardlink"])("reconciles file-object registration aliases: %s", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const markerPath = path.join(f.repository, ".git", "daynight", "worktrees", `${f.owner.worktreeId}.json`), marker = await readFile(markerPath);
      const original = path.join(binding.worktreePath, ".git");
      const target = kind === "case-alias" ? path.join(binding.worktreePath, ".GIT") : path.join(f.root, "linked.git");
      if (kind === "hardlink") await link(original, target);
      const originalStat = await lstat(original, { bigint: true });
      const aliasStat = await lstat(target, { bigint: true }).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      // Case-sensitive volumes retain a genuinely missing .GIT target. Other
      // volumes must recognize the existing file regardless of its spelling.
      const duplicate = aliasStat !== null;
      if (duplicate) expect([aliasStat.dev, aliasStat.ino]).toEqual([originalStat.dev, originalStat.ino]);
      if (kind === "hardlink") expect(originalStat.nlink).toBe(2n);
      const manual = path.join(f.root, "manual");
      git(f.repository, ["worktree", "add", "--detach", manual, "HEAD"]);
      const pointer = path.join(administrativeDirectory(manual), "gitdir");
      await writeFile(pointer, `${target}\n`);
      git(binding.worktreePath, ["checkout", "-b", "changed-branch"]);
      const scan = await adapter.scanWorktrees(f.project, operation());
      if (duplicate) {
        expect(scan.unknown.length).toBeGreaterThan(0);
        expect(scan.quarantined).toEqual([]);
      } else {
        expect(scan.unknown).toEqual([]);
        expect(scan.quarantined).toEqual([{ owner: f.owner, error: expect.objectContaining({ code: "branch_mismatch" }) }]);
      }
      git(binding.worktreePath, ["checkout", binding.branch]);
      if (duplicate) {
        await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
        await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow();
        await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow();
      } else {
        expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding }]);
        await expect(adapter.verifyWorktree(f.project, f.owner, operation())).resolves.toEqual(binding);
      }
      expect(await readFile(markerPath)).toEqual(marker);
      expect(await readFile(pointer, "utf8")).toBe(`${target}\n`);
      expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
      expect(await readFile(path.join(manual, "tracked.txt"), "utf8")).toBe("original\n");
    });

    it.each(["duplicate", "duplicate-missing", "duplicate-final-symlink", "unresolved", "unrelated", "unrelated-missing"])("proves physical registration targets with a %s manual alias", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const markerPath = path.join(f.repository, ".git", "daynight", "worktrees", `${f.owner.worktreeId}.json`), marker = await readFile(markerPath);
      git(binding.worktreePath, ["checkout", "-b", "changed-branch"]);
      const manual = path.join(f.root, "manual");
      git(f.repository, ["worktree", "add", "--detach", manual, "HEAD"]);
      const admin = administrativeDirectory(manual), pointer = path.join(admin, "gitdir"), alias = path.join(f.root, "alias");
      await symlink(kind === "unresolved" ? path.join(f.root, "missing") : f.root, alias, process.platform === "win32" ? "junction" : "dir");
      const target = kind === "duplicate-final-symlink" ? path.join(manual, ".git")
        : kind.startsWith("unrelated") ? path.join(alias, "manual", ".git") : path.join(alias, path.relative(f.root, binding.worktreePath), ".git");
      if (kind === "duplicate-final-symlink") {
        await rm(target);
        await symlink(path.join(binding.worktreePath, ".git"), target, "file");
      }
      await writeFile(pointer, `${target}\n`);
      if (kind === "duplicate-missing") await rm(binding.worktreePath, { recursive: true });
      if (kind === "unrelated-missing") await rm(manual, { recursive: true });
      const result = await adapter.scanWorktrees(f.project, operation());
      if (kind.startsWith("unrelated")) {
        expect(result.unknown).toEqual([]);
        expect(result.quarantined).toEqual([{ owner: f.owner, error: expect.objectContaining({ code: "branch_mismatch" }) }]);
        git(binding.worktreePath, ["checkout", binding.branch]);
        expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding }]);
      } else {
        expect(result.unknown.length).toBeGreaterThan(0);
        expect(result.quarantined).toEqual([]);
        await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
        await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow();
        await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow();
      }
      expect(await readFile(pointer, "utf8")).toBe(`${target}\n`);
      expect(await readFile(markerPath)).toEqual(marker);
      if (kind === "duplicate-final-symlink") expect((await lstat(target)).isSymbolicLink()).toBe(true);
      if (kind !== "duplicate-missing") expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
      if (kind !== "unrelated-missing") expect(await readFile(path.join(manual, "tracked.txt"), "utf8")).toBe("original\n");
    }, 20000);

    it("quarantines a known registration without losing or invalidating its healthy sibling", async () => {
      const f = await fixture(), adapter = manager(f.root);
      const broken = await adapter.prepareWorktree(f.project, f.owner, operation());
      const owner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "88888888-8888-4888-8888-888888888888", worktreeId: "99999999-9999-4999-8999-999999999999" };
      const healthy = await adapter.prepareWorktree(f.project, owner, operation());
      git(broken.worktreePath, ["checkout", "-b", "changed-branch"]);
      const result = await adapter.scanWorktrees(f.project, operation());
      expect(result.enumerationComplete).toBe(true);
      expect(result.unknown).toEqual([]);
      expect(result.validated).toEqual([{ owner, binding: healthy }]);
      expect(result.quarantined).toEqual([{ owner: f.owner, error: expect.objectContaining({ code: "branch_mismatch" }) }]);
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow("original task branch");
      await expect(adapter.verifyWorktree(f.project, owner, operation())).resolves.toEqual(healthy);
      git(broken.worktreePath, ["checkout", broken.branch]);
      expect((await adapter.scanWorktrees(f.project, operation())).quarantined).toEqual([]);
    });

    it.each(["marker", "unknown-marker", "pointer", "duplicate", "unreadable", "commondir"])("keeps %s damage unknown while preserving healthy observations", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const admin = administrativeDirectory(binding.worktreePath);
      const siblingOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "88888888-8888-4888-8888-888888888888", worktreeId: "99999999-9999-4999-8999-999999999999" };
      const sibling = await adapter.prepareWorktree(f.project, siblingOwner, operation());
      if (kind === "marker") await writeFile(path.join(admin, "locked"), "daynight-worker:{");
      if (kind === "unknown-marker") await writeFile(path.join(admin, "locked"), "daynight-worker:{}");
      if (kind === "commondir") { await rm(path.join(admin, "commondir")); await mkdir(path.join(admin, "commondir")); }
      if (kind === "pointer") await writeFile(path.join(admin, "gitdir"), path.join(f.root, "foreign", ".git"));
      if (kind === "duplicate") cpSync(admin, `${admin}-duplicate`, { recursive: true });
      if (kind === "unreadable") { await rm(path.join(admin, "gitdir")); await mkdir(path.join(admin, "gitdir")); }
      const result = await adapter.scanWorktrees(f.project, operation());
      expect(result.unknown.length).toBeGreaterThan(0);
      if (kind !== "unreadable") {
        expect(result.quarantined).toEqual([]);
        expect(result.validated).toEqual([{ owner: siblingOwner, binding: sibling }]);
        await expect(adapter.verifyWorktree(f.project, siblingOwner, operation())).resolves.toEqual(sibling);
      }
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    });

    it.each(["symlink", "file"])("keeps a registration replaced by a %s unknown without reading through it", async kind => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const admin = administrativeDirectory(binding.worktreePath), retained = path.join(f.root, "retained-admin");
      await rename(admin, retained);
      const marker = await readFile(path.join(retained, "gitdir"), "utf8");
      if (kind === "symlink") await symlink(retained, admin, "dir");
      else await writeFile(admin, "unreadable registration");
      const scan = await adapter.scanWorktrees(f.project, operation());
      expect(scan.unknown.length).toBeGreaterThan(0);
      expect(scan.validated).toEqual([]); expect(scan.quarantined).toEqual([]);
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      expect(await readFile(path.join(retained, "gitdir"), "utf8")).toBe(marker);
    });

    it.each(["manual", "missing"])("keeps unreadable Git pointers unknown with a %s marker", async marker => {
      const f = await fixture(), adapter = manager(f.root);
      const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const siblingOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "88888888-8888-4888-8888-888888888888", worktreeId: "99999999-9999-4999-8999-999999999999" };
      await adapter.prepareWorktree(f.project, siblingOwner, operation());
      const admin = administrativeDirectory(binding.worktreePath), pointer = path.join(admin, "gitdir");
      if (marker === "manual") await writeFile(path.join(admin, "locked"), "human");
      else await rm(path.join(admin, "locked"), { force: true });
      const original = await readFile(pointer, "utf8"), retained = path.join(f.root, "retained-gitdir");
      await writeFile(retained, original); await rm(pointer); await symlink(retained, pointer);
      const scan = await adapter.scanWorktrees(f.project, operation());
      expect(scan.unknown.length).toBeGreaterThan(0);
      expect(scan.quarantined).toEqual([]);
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      // Its target is unknown, so a duplicate of the healthy registration
      // cannot be excluded. Strict execution must retain that uncertainty.
      await expect(adapter.verifyWorktree(f.project, siblingOwner, operation())).rejects.toThrow();
      expect(await readFile(retained, "utf8")).toBe(original);
    });

    it("does not inventory ordinary unregistered paths or manual worktrees", async () => {
      const f = await fixture(), adapter = manager(f.root);
      await adapter.prepareRepository(f.project, operation());
      await mkdir(path.join(f.repository, ".worktrees", "daynight", f.owner.taskId), { recursive: true });
      await writeFile(path.join(f.repository, ".worktrees", "daynight", f.owner.taskId, "keep"), "unowned");
      git(f.repository, ["worktree", "add", "--detach", path.join(f.root, "manual"), "HEAD"]);
      expect(await adapter.scanWorktrees(f.project, operation())).toEqual({ enumerationComplete: true, validated: [], quarantined: [], unknown: [] });
    });

    it("propagates an expired deadline without turning it into empty coverage", async () => {
      const f = await fixture(), adapter = manager(f.root);
      const op = createOperation({ limits: { totalMs: 1 } }); operations.push(op);
      await new Promise(resolve => setTimeout(resolve, 5));
      await expect(adapter.scanWorktrees(f.project, op)).rejects.toMatchObject({ kind: "deadline" });
    });

    it("propagates cancellation instead of reporting an empty or quarantined scan", async () => {
      const f = await fixture(), adapter = manager(f.root), abort = new AbortController();
      abort.abort(); const op = createOperation({ signal: abort.signal }); operations.push(op);
      await expect(adapter.scanWorktrees(f.project, op)).rejects.toMatchObject({ kind: "cancelled" });
    });
  });

  it("limits discovered resources to the requested project's static ownership", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const otherProject = { ...f.project, projectId: "88888888-8888-4888-8888-888888888888" };
    const otherOwner = { ...f.owner, projectId: otherProject.projectId };
    const binding = await adapter.prepareWorktree(otherProject, otherOwner, operation());
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    expect(await adapter.listWorktrees(otherProject, operation())).toEqual([{ owner: otherOwner, binding }]);
  });

  it("validates an existing root and keeps dirty repository work", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    await writeFile(path.join(f.repository, "tracked.txt"), "uncommitted\n"); await writeFile(path.join(f.repository, "untracked.txt"), "retained\n");
    const actual = await adapter.prepareRepository(f.project, operation());
    expect(actual.root).toBe(f.repository); expect(actual.commonDirectory).toBe(path.join(f.repository, ".git"));
    expect(git(f.repository, ["status", "--porcelain"])).toContain(" M tracked.txt");
    expect(await readFile(path.join(f.repository, "untracked.txt"), "utf8")).toBe("retained\n");
  });

  it("clones a missing repository using the owned runner and empty template", async () => {
    const f = await fixture(); const destination = path.join(f.root, "clone"); let cloneTimeout = 0;
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      if (!args.includes("clone")) return runRepositoryGit(cwd, args, op, options);
      expect(args.some((value) => value.startsWith("--template="))).toBe(true); cloneTimeout = options?.timeoutMs ?? 0;
      const rewritten = args.map((value) => value === remote ? f.repository : value);
      const result = await runRepositoryGit(cwd, rewritten, op, options);
      git(destination, ["remote", "set-url", "origin", remote]);
      return result;
    }) });
    const result = await adapter.prepareRepository({ ...f.project, localPath: destination }, operation());
    expect(result.root).toBe(destination); expect(cloneTimeout).toBe(120_000); expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("refreshes the remote default again after cloning a missing repository", async () => {
    const f = await fixture(); const destination = path.join(f.root, "clone"); let latest = "";
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      if (!args.includes("clone")) return runRepositoryGit(cwd, args, op, options);
      const result = await runRepositoryGit(cwd, args.map(value => value === remote ? f.bare : value), op, options);
      git(destination, ["remote", "set-url", "origin", remote]);
      git(destination, ["config", `url.${f.bare}.insteadOf`, remote]);
      latest = commitForOrigin(f.repository, f.bare, "main", "advanced after clone");
      return result;
    }) });
    const clone = { ...f.project, localPath: destination };
    await adapter.prepareRepository(clone, operation());
    const binding = await adapter.prepareWorktree(clone, f.owner, operation());
    expect(git(binding.worktreePath, ["rev-parse", "HEAD"])).toBe(latest);
    expect(privateBases(destination)).toBe("");
  });

  it("retries empty failed clone reservations and rejects existing nonrepositories, nested paths and mismatched origins", async () => {
    const f = await fixture(); const failed = new Error("controlled clone failure"); let attempts = 0;
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => { if (args.includes("clone")) { attempts += 1; throw failed; } return runRepositoryGit(cwd, args, op, options); }) });
    const destination = path.join(f.root, "failed clone");
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toBe(failed);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toBe(failed); expect(attempts).toBe(2);
    await mkdir(destination);
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toThrow(/Git command failed|worktree root/); expect(attempts).toBe(2);
    await mkdir(path.join(f.repository, "nested"));
    await expect(adapter.prepareRepository({ ...f.project, localPath: path.join(f.repository, "nested") }, operation())).rejects.toThrow("worktree root");
    await expect(adapter.prepareRepository({ ...f.project, repoUrl: "https://example.com/other/repository.git" }, operation())).rejects.toThrow("origin does not match");
  });

  it("retains nonempty failed clone output", async () => {
    const f = await fixture(); const destination = path.join(f.root, "partial clone"), failed = new Error("clone failed");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      if (!args.includes("clone")) return runRepositoryGit(cwd, args, op, options);
      await writeFile(path.join(destination, "retained"), "user data");
      throw failed;
    }) });
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toBe(failed);
    expect(await readFile(path.join(destination, "retained"), "utf8")).toBe("user data");
  });

  it("creates an unlocked worktree at the worktreeId path and task branch", async () => {
    const f = await fixture(), adapter = manager(f.root), binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(binding.worktreePath).toBe(path.join(f.repository, ".worktrees", "daynight", ids.worktreeId));
    expect(binding.branch).toBe(`daynight/${ids.taskId}`);
    expect(git(binding.worktreePath, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${binding.branch}`);
    const manifest = createWorktreeManifestStore(path.join(f.repository, ".git")).read(ids.worktreeId);
    expect(manifest).toEqual({ schemaVersion: 1, ...f.owner, directoryName: ids.worktreeId });
    await expect(lstat(path.join(administrativeDirectory(binding.worktreePath), "locked"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.prepareWorktree(f.project, f.owner, operation())).toEqual(binding);
  });

  it("starts from the fetched remote HEAD even with a stale local default and another dirty checkout", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const initial = git(f.repository, ["rev-parse", "HEAD"]);
    git(f.repository, ["checkout", "-b", "local-work"]);
    git(f.repository, ["update-ref", `refs/daynight/worker-bases/${f.owner.worktreeId}`, initial]);
    git(f.repository, ["update-ref", "refs/remotes/origin/main", initial]);
    git(f.repository, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const latest = commitForOrigin(f.repository, f.bare, "trunk", "new remote default");
    git(f.bare, ["symbolic-ref", "HEAD", "refs/heads/trunk"]);
    await writeFile(path.join(f.repository, "tracked.txt"), "local dirty work\n");
    await writeFile(path.join(f.repository, "untracked"), "keep\n");
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(git(binding.worktreePath, ["rev-parse", "HEAD"])).toBe(latest);
    expect(git(f.repository, ["rev-parse", `refs/heads/${binding.branch}`])).toBe(latest);
    expect(git(f.repository, ["rev-parse", "HEAD"])).toBe(initial);
    expect(git(f.repository, ["symbolic-ref", "HEAD"])).toBe("refs/heads/local-work");
    expect(git(f.repository, ["symbolic-ref", "refs/remotes/origin/HEAD"])).toBe("refs/remotes/origin/main");
    expect(await readFile(path.join(f.repository, "tracked.txt"), "utf8")).toBe("local dirty work\n");
    expect(await readFile(path.join(f.repository, "untracked"), "utf8")).toBe("keep\n");
    expect(privateBases(f.repository)).toBe("");
  });

  it("fails closed when the remote HEAD cannot be fetched, while retaining existing work", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const initial = git(f.repository, ["rev-parse", "HEAD"]);
    await writeFile(path.join(f.repository, "tracked.txt"), "keep dirty\n");
    await rename(f.bare, `${f.bare}.offline`);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow();
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
    expect(git(f.repository, ["rev-parse", "HEAD"])).toBe(initial);
    expect(await readFile(path.join(f.repository, "tracked.txt"), "utf8")).toBe("keep dirty\n");
  });

  it("rejects a remote HEAD that does not resolve to a commit", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const blob = git(f.repository, ["hash-object", "-w", "tracked.txt"]);
    git(f.repository, ["push", f.bare, `${blob}:refs/tags/not-a-commit`]);
    git(f.bare, ["symbolic-ref", "HEAD", "refs/tags/not-a-commit"]);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow();
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
  });

  it("never reuses a stale private ref when remote HEAD is absent", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const old = git(f.repository, ["rev-parse", "HEAD"]);
    const ref = `refs/daynight/worker-bases/${f.owner.worktreeId}`;
    git(f.repository, ["update-ref", ref, old]);
    git(f.bare, ["symbolic-ref", "HEAD", "refs/heads/missing"]);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow();
    expect(git(f.repository, ["rev-parse", ref])).toBe(old);
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
  });

  it("preserves both creation and private-ref cleanup failures", async () => {
    const f = await fixture(); const creation = new Error("controlled worktree failure"), cleanup = new Error("controlled ref cleanup failure");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      if (args.includes("worktree") && args.includes("add")) throw creation;
      if (args.includes("update-ref") && args.includes("-d")) throw cleanup;
      return runRepositoryGit(cwd, args, op, options);
    }) });
    const failure = await adapter.prepareWorktree(f.project, f.owner, operation()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: creation, errors: [creation, cleanup] });
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
  });

  it("reuses dirty worktrees and retained task branches while origin is offline", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const retained = git(binding.worktreePath, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "retained"]);
    git(binding.worktreePath, ["reset", "--hard", retained]);
    await writeFile(path.join(binding.worktreePath, "tracked.txt"), "dirty task work\n");
    await rename(f.bare, `${f.bare}.offline`);
    expect(await adapter.prepareWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("dirty task work\n");
    await adapter.removeWorktree(f.project, f.owner, operation());
    const restored = await adapter.prepareWorktree(f.project, changedClaim(f.owner), operation());
    expect(git(restored.worktreePath, ["rev-parse", "HEAD"])).toBe(retained);
  });

  // Both real Git preparations stay inside the barrier-controlled race, including native process startup.
  it("keeps concurrent tasks on their own fetched commits", async () => {
    const f = await fixture();
    const firstHead = git(f.repository, ["rev-parse", "HEAD"]);
    const fetchHead = path.join(f.repository, ".git", "FETCH_HEAD");
    await writeFile(fetchHead, "sentinel\n");
    git(f.repository, ["update-ref", "refs/remotes/origin/main", firstHead]);
    let fetched!: () => void; const firstFetched = new Promise<void>(resolve => { fetched = resolve; });
    let release!: () => void; const firstMayContinue = new Promise<void>(resolve => { release = resolve; });
    let fetches = 0;
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (args.includes("fetch") && ++fetches === 1) { fetched(); await firstMayContinue; }
      return result;
    }) });
    const otherOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", worktreeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const first = reservation(adapter.prepareWorktree(f.project, f.owner, operation()));
    try {
      await firstFetched;
      const secondHead = commitForOrigin(f.repository, f.bare, "main", "remote advances between fetches");
      expect(git(f.repository, ["rev-parse", "refs/remotes/origin/main"])).toBe(firstHead);
      const second = await reservation(adapter.prepareWorktree(f.project, otherOwner, operation()));
      release();
      const firstBinding = await first;
      expect(git(firstBinding.worktreePath, ["rev-parse", "HEAD"])).toBe(firstHead);
      expect(git(second.worktreePath, ["rev-parse", "HEAD"])).toBe(secondHead);
      expect(await readFile(fetchHead, "utf8")).toBe("sentinel\n");
      expect(git(f.repository, ["rev-parse", "refs/remotes/origin/main"])).toBe(firstHead);
      expect(privateBases(f.repository)).toBe("");
    } finally { release(); await Promise.allSettled([first]); }
  }, 30_000);

  it("exposes a real fetch timeout without creating a branch or registration", async () => {
    const f = await fixture(); const blocker = path.join(f.root, "block-fetch.cjs");
    await writeFile(blocker, "setInterval(() => {}, 1000);\n");
    git(f.repository, ["config", "remote.origin.uploadpack", `\"${process.execPath}\" \"${blocker}\"`]);
    const adapter = manager(f.root, { startOwnedGit: (cwd, args, op, options) => startOwnedRepositoryGit(cwd, args, op, args.includes("fetch") ? { ...options, timeoutMs: 1500 } : options) });
    const failure = await adapter.prepareWorktree(f.project, f.owner, operation()).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(errorText(failure)).toContain("deadline exceeded");
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
  });

  it("does not create a branch when cancellation interrupts the refresh", async () => {
    const f = await fixture(); const controller = new AbortController(); const cancelled = new Error("refresh cancelled");
    let fetching!: () => void; const started = new Promise<void>(resolve => { fetching = resolve; });
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      if (args.includes("fetch")) {
        fetching();
        await new Promise<void>(resolve => op.signal.addEventListener("abort", () => resolve(), { once: true }));
        op.check();
      }
      return runRepositoryGit(cwd, args, op, options);
    }) });
    const op = createOperation({ signal: controller.signal }); operations.push(op);
    const pending = reservation(adapter.prepareWorktree(f.project, f.owner, op));
    await started; controller.abort(cancelled);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled", cause: cancelled });
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
  });



  it("recovers an add whose successful result was lost without resetting dirty work", async () => {
    const f = await fixture(); const lost = new Error("lost add response"); let added = false;
    const first = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => { const result = await runRepositoryGit(cwd, args, op, options); if (args.includes("add") && args.includes("worktree")) { added = true; throw lost; } return result; }) });
    await expect(first.prepareWorktree(f.project, f.owner, operation())).rejects.toBe(lost); expect(added).toBe(true);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId); await writeFile(path.join(target, "tracked.txt"), "changed\n"); await writeFile(path.join(target, "untracked"), "kept\n");
    const second = manager(f.root); const binding = await second.prepareWorktree(f.project, f.owner, operation());
    expect(await second.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(target, "tracked.txt"), "utf8")).toBe("changed\n"); expect(await readFile(path.join(target, "untracked"), "utf8")).toBe("kept\n");
  });

  it("restores a missing original worktree but never recreates its repository", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await rm(binding.worktreePath, { recursive: true });
    await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow("cannot be recreated");
    expect(await adapter.prepareWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    await rename(f.repository, path.join(f.root, "old repository"));
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("original repository");
  });

  it("rejects foreign claims, nonempty unmarked reservations and mismatched projects", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await expect(adapter.prepareWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("already checked out");
    expect(errorText(await adapter.removeWorktree(f.project, changedClaim(f.owner), {}).catch(error => error))).toContain("manifest is missing");
    await expect(adapter.verifyWorktree({ ...f.project, projectId: "88888888-8888-4888-8888-888888888888" }, f.owner, operation())).rejects.toThrow("does not belong to this project");
    await adapter.removeWorktree(f.project, f.owner, operation()); await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "keep\n");
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("no matching Git registration");
    expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("keep\n");
  }, 30_000);

  it.each(["original claim", "new claim"] as const)("reuses an empty unregistered reservation for the %s", async (kind) => {
    const f = await fixture(); const adapter = manager(f.root);
    // We construct retained state directly to reserve the test budget for actual reservation recovery.
    const branch = `daynight/${f.owner.taskId}`;
    const previousHead = git(f.repository, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "retained task branch"]);
    git(f.repository, ["branch", branch, previousHead]);
    const owner = kind === "new claim" ? changedClaim(f.owner) : f.owner;
    const target = path.join(f.repository, ".worktrees", "daynight", owner.worktreeId);
    await mkdir(target, { recursive: true });
    expect(await readdir(target)).toEqual([]);
    expect(worktreePaths(f.repository)).not.toContain(path.normalize(target));
    const binding = await reservation(adapter.prepareWorktree(f.project, owner, operation()));
    expect(binding.worktreePath).toBe(target);
    expect(await reservation(adapter.verifyWorktree(f.project, owner, operation()))).toEqual(binding);
    expect(git(f.repository, ["rev-parse", binding.branch])).toBe(previousHead);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    if (kind === "new claim") await expect(reservation(adapter.verifyWorktree(f.project, f.owner, operation()))).rejects.toThrow("cannot be recreated");
  });

  it("recovers an interrupted reservation before Git created its branch or registration", async () => {
    const f = await fixture(); const failed = new Error("interrupted before Git worktree add");
    const first = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      if (args.includes("worktree") && args.includes("add")) throw failed;
      return runRepositoryGit(cwd, args, op, options);
    }) });
    await expect(first.prepareWorktree(f.project, f.owner, operation())).rejects.toBe(failed);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    expect(await readdir(target)).toEqual([]);
    const restarted = manager(f.root);
    const binding = await restarted.prepareWorktree(f.project, f.owner, operation());
    expect(await restarted.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("removes dirty terminal worktree with the cleanup Git budget while preserving branches and unrelated work", async () => {
    const f = await fixture(); const timeouts: (number | undefined)[] = [];
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { timeouts.push(options?.timeoutMs); return runRepositoryGit(cwd, args, op, options); }, startOwnedGit: (cwd, args, op, options) => { timeouts.push(options?.timeoutMs); return startOwnedRepositoryGit(cwd, args, op, options); } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(timeouts).toContain(120_000); expect(timeouts.every(timeout => timeout === 30_000 || timeout === 120_000)).toBe(true);
    timeouts.length = 0;
    await writeFile(path.join(binding.worktreePath, "unpublished"), "terminal temp\n"); await writeFile(path.join(f.repository, "unrelated"), "keep\n");
    await adapter.removeWorktree(f.project, f.owner, {});
    expect(timeouts.length).toBeGreaterThan(0); expect(timeouts.every(timeout => timeout === 300_000)).toBe(true);
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/${binding.branch}`])).toBe(`refs/heads/${binding.branch}`);
    expect(await readFile(path.join(f.repository, "unrelated"), "utf8")).toBe("keep\n"); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    await adapter.removeWorktree(f.project, f.owner, operation());
  });

  it("continues partial content deletion while preserving the original Git pointer", async () => {
    const f = await fixture(); const failure = new Error("controlled partial filesystem removal"); let partial = true;
    const adapter = manager(f.root, { removeDirectory: async (target, options) => { await rm(target, options); if (partial) { partial = false; throw failure; } } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation()); const admin = administrativeDirectory(binding.worktreePath);
    const pointer = await readFile(path.join(binding.worktreePath, ".git"), "utf8");
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toBe(failure);
    expect(createWorktreeManifestStore(path.join(f.repository, ".git")).read(ids.worktreeId)).toMatchObject(f.owner);
    expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toBe(pointer);
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });



  it("uses a fresh observation budget after the effect deadline", async () => {
    const f = await fixture(); let offset = 0;
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (args.includes("worktree") && args.includes("remove")) offset = 301_000;
      return result;
    }) });
    await adapter.prepareWorktree(f.project, f.owner, operation());
    const now = performance.now.bind(performance);
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
    try {
      const result = await adapter.removeWorktree(f.project, f.owner, {});
      expect(result.kind).toBe("absent");
      expect(result.effectErrors).toHaveLength(1);
      expect(result.effectErrors[0]).toMatchObject({ kind: "deadline" });
    } finally { clock.mockRestore(); }
  });

  it("reports an effect deadline after the already-absent early return", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    await adapter.prepareWorktree(f.project, f.owner, operation());
    await adapter.removeWorktree(f.project, f.owner, {});
    const now = performance.now.bind(performance); let offset = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + offset);
    registrationBoundary.afterRead = () => { registrationBoundary.afterRead = undefined; offset = 301_000; };
    try {
      const result = await adapter.removeWorktree(f.project, f.owner, {});
      expect(result.kind).toBe("absent");
      expect(result.effectErrors).toHaveLength(1);
      expect(result.effectErrors[0]).toMatchObject({ kind: "deadline" });
    } finally { registrationBoundary.afterRead = undefined; clock.mockRestore(); }
  });

  it("does not observe absence when repository validation fails before acquiring the gate", async () => {
    const f = await fixture(); const failure = new Error("repository observation failed"); let armed = false; let reads = 0;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (armed) { reads++; if (reads === 1) throw failure; }
      return runRepositoryGit(cwd, args, op, options);
    } });
    await adapter.prepareWorktree(f.project, f.owner, operation());
    await adapter.removeWorktree(f.project, f.owner, {});
    armed = true;
    await expect(adapter.removeWorktree(f.project, f.owner, {})).rejects.toBe(failure);
    expect(reads).toBe(1);
  });

  it("preserves both removal and fresh observation errors", async () => {
    const f = await fixture(); const effect = new Error("remove failed"); const observation = new Error("observation failed"); let removed = false;
    const adapter = manager(f.root, {
      startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
        if (args.includes("worktree") && args.includes("remove")) { removed = true; throw effect; }
        return runRepositoryGit(cwd, args, op, options);
      }),
      runGit: async (cwd, args, op, options) => {
        if (removed) throw observation;
        return runRepositoryGit(cwd, args, op, options);
      },
    });
    await adapter.prepareWorktree(f.project, f.owner, operation());
    const error = await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ cause: effect, errors: [effect, observation] });
  });

  it("waits for the original Git join before observing absence", async () => {
    const f = await fixture(); const joined = Promise.withResolvers<GitSettlement>(); const reported = Promise.withResolvers<void>();
    const failure = new RepositoryGitCleanupPendingError([], new Error("Git outcome failed after removal")); let readsAfterRemoval = 0; let removed = false;
    const adapter = manager(f.root, {
      runGit: async (cwd, args, op, options) => { if (removed) readsAfterRemoval++; return runRepositoryGit(cwd, args, op, options); },
      startOwnedGit: (cwd, args, op, options) => {
        if (!args.includes("worktree") || !args.includes("remove")) return startOwnedRepositoryGit(cwd, args, op, options);
        const outcome = runRepositoryGit(cwd, args, op, options).then(() => { removed = true; reported.resolve(); return { kind: "cleanup-pending" as const, error: failure }; });
        return { outcome, joined: joined.promise, requestStop: () => {} };
      },
    });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const second = manager(f.root);
    let completed = false;
    const result = adapter.removeWorktree(f.project, f.owner, {}).finally(() => { completed = true; });
    try {
      await reported.promise; await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toBe(false); expect(readsAfterRemoval).toBe(0);
      await expect(second.removeWorktree(f.project, f.owner, {})).rejects.toThrow("already in progress");
      expect(readsAfterRemoval).toBe(0);
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    } finally { joined.resolve({ kind: "local-closed", cleanupErrors: [] }); }
    expect(await result).toEqual({ kind: "absent", effectErrors: [failure] });
    expect(readsAfterRemoval).toBeGreaterThan(0);
  });

  it("does not start a fresh observation after outer cancellation", async () => {
    const f = await fixture(); const controller = new AbortController(); let removed = false; let readsAfterRemoval = 0;
    const adapter = manager(f.root, {
      runGit: async (cwd, args, op, options) => { if (removed) readsAfterRemoval++; return runRepositoryGit(cwd, args, op, options); },
      startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
        const result = await runRepositoryGit(cwd, args, op, options);
        if (args.includes("worktree") && args.includes("remove")) { removed = true; controller.abort(new Error("shutdown")); }
        return result;
      }),
    });
    await adapter.prepareWorktree(f.project, f.owner, operation());
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(error => error);
    expect(errorText(error)).toContain("shutdown"); expect(readsAfterRemoval).toBe(0);
  });

  it("preserves an effect error and cancellation between budgets without observing again", async () => {
    const f = await fixture(); const controller = new AbortController();
    const effect = new Error("lost removal response"), shutdown = new Error("shutdown between budgets");
    let removed = false; let readsAfterRemoval = 0;
    const adapter = manager(f.root, {
      runGit: async (cwd, args, op, options) => { if (removed) readsAfterRemoval++; return runRepositoryGit(cwd, args, op, options); },
      startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
        const result = await runRepositoryGit(cwd, args, op, options);
        if (args.includes("worktree") && args.includes("remove")) { removed = true; controller.abort(shutdown); throw effect; }
        return result;
      }),
    });
    await adapter.prepareWorktree(f.project, f.owner, operation());
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(effect);
    expect(error.errors[0]).toBe(effect);
    expect(error.errors[1]).toMatchObject({ kind: "cancelled", cause: shutdown });
    expect(readsAfterRemoval).toBe(0);
  });

  it.each([false, true])("preserves cancellation after a successful fresh observation (effect failed: %s)", async (failEffect) => {
    const f = await fixture(); const controller = new AbortController(); const shutdown = new Error("shutdown after observation");
    const effect = new Error("lost removal response");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (failEffect && args.includes("worktree") && args.includes("remove")) throw effect;
      return result;
    }) });
    await adapter.prepareWorktree(f.project, f.owner, operation());
    let completed = 0;
    cleanupBoundary.afterSuccess = () => { if (++completed === (failEffect ? 1 : 2)) controller.abort(shutdown); };
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(error => error);
    if (failEffect) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.cause).toBe(effect);
      expect(error.errors[0]).toBe(effect);
      expect(error.errors[1]).toMatchObject({ kind: "cancelled", cause: shutdown });
    } else {
      expect(error).toMatchObject({ kind: "cancelled", cause: shutdown });
    }
  });

  it("keeps cancellation joined and rejects overlapping cleanup until the original removal settles", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const adapter = manager(f.root, { removeDirectory: async (target, options) => {
      entered.resolve(); await release.promise; await rm(target, options);
    } });
    const second = manager(f.root);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const controller = new AbortController(); const op = createOperation({ signal: controller.signal }); operations.push(op);
    let settled = false;
    const result = adapter.removeWorktree(f.project, f.owner, op).then(() => { settled = true; return null; }, error => { settled = true; return error; });
    try {
      await Promise.race([entered.promise, result.then(error => { throw error ?? new Error("Removal never entered the controlled filesystem operation."); })]);
      controller.abort();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      await expect(second.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("already in progress");
    } finally { release.resolve(); }
    expect(errorText(await result)).toContain("Operation cancelled.");
    expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toContain("gitdir: ");
    await second.removeWorktree(f.project, f.owner, operation());
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("cleans read-only module directories without changing external links or retained commits", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const head = git(f.repository, ["rev-parse", binding.branch]);
    const cache = path.join(binding.worktreePath, "go-mod");
    const nested = path.join(cache, "example@v1", "source");
    const outside = path.join(f.root, "outside");
    await mkdir(nested, { recursive: true }); await mkdir(outside);
    await writeFile(path.join(outside, "shared"), "preserve external bytes\n", { mode: 0o444 });
    await link(path.join(outside, "shared"), path.join(nested, "hardlink"));
    await symlink(outside, path.join(nested, "external-directory"));
    await writeFile(path.join(nested, "module.go"), "package module\n", { mode: 0o444 });
    const protectedDirectories = [cache, path.dirname(nested), nested, outside];
    for (const target of protectedDirectories) await chmod(target, 0o555);
    try {
      // A real unprivileged filesystem failure distinguishes this regression from a mocked rm error.
      await expect(rm(cache, { recursive: true })).rejects.toMatchObject({ code: "EACCES" });
      expect(errorText(await adapter.removeWorktree(f.project, changedClaim(f.owner), {}).catch(error => error))).toContain("manifest is missing");
      expect((await lstat(nested)).mode & 0o777).toBe(0o555);
      await adapter.removeWorktree(f.project, f.owner, operation());
      await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
      expect(git(f.repository, ["rev-parse", binding.branch])).toBe(head);
      expect(await readFile(path.join(outside, "shared"), "utf8")).toBe("preserve external bytes\n");
      expect((await lstat(path.join(outside, "shared"))).mode & 0o777).toBe(0o444);
      expect((await lstat(outside)).mode & 0o777).toBe(0o555);
    } finally {
      for (const target of protectedDirectories) {
        try { await chmod(target, 0o755); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      }
    }
  });

  it("retains a pointerless leaf and a replacement instead of recursively deleting either", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await rm(path.join(binding.worktreePath, ".git"));
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer is missing"); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    await rename(binding.worktreePath, `${binding.worktreePath}-original`); await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "must survive\n");
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer is missing"); expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("must survive\n");
  });

  it("retains delete-and-recreate replacements after leaf deletion but before administrative cleanup", async () => {
    const f = await fixture(); const interrupted = new Error("interrupted before administrative removal");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => { if (args.includes("worktree") && args.includes("remove")) throw interrupted; return runRepositoryGit(cwd, args, op, options); }) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation()); const admin = administrativeDirectory(binding.worktreePath);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toBe(interrupted); await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "must survive inode reuse\n");
    const second = manager(f.root); expect(errorText(await second.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer is missing");
    expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("must survive inode reuse\n"); expect(createWorktreeManifestStore(path.join(f.repository, ".git")).read(ids.worktreeId)).toMatchObject(f.owner);
    await rm(binding.worktreePath, { recursive: true }); await second.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("finishes an empty leaf and its registration after the final pointer unlink interruption", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    for (const name of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, name), { recursive: true });
    const restarted = manager(f.root);
    expect((await restarted.scanWorktrees(f.project, operation())).quarantined).toHaveLength(1);
    await restarted.removeWorktree(f.project, f.owner, operation());
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("reconciles a lost successful administrative removal and rejects a new claim at the old path", async () => {
    const f = await fixture(); const lost = new Error("lost remove response");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => { const result = await runRepositoryGit(cwd, args, op, options); if (args.includes("worktree") && args.includes("remove")) throw lost; return result; }) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(await adapter.removeWorktree(f.project, f.owner, {})).toEqual({ kind: "absent", effectErrors: [lost] });
    const second = manager(f.root); await second.removeWorktree(f.project, f.owner, operation());
    const next = changedClaim(f.owner); const fresh = await second.prepareWorktree(f.project, next, operation()); expect(fresh.worktreePath).not.toBe(binding.worktreePath);
    await second.removeWorktree(f.project, f.owner, operation()); expect(await readFile(path.join(fresh.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  }, 30_000);

  it("preserves retained branch commits for a fresh claim without reset", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await writeFile(path.join(binding.worktreePath, "delivered"), "committed\n"); git(binding.worktreePath, ["add", "delivered"]); git(binding.worktreePath, ["commit", "-m", "delivered"]); const head = git(binding.worktreePath, ["rev-parse", "HEAD"]);
    await adapter.removeWorktree(f.project, f.owner, operation()); const fresh = await adapter.prepareWorktree(f.project, changedClaim(f.owner), operation());
    expect(git(fresh.worktreePath, ["rev-parse", "HEAD"])).toBe(head); expect(await readFile(path.join(fresh.worktreePath, "delivered"), "utf8")).toBe("committed\n");
  });

  it("disables setup hooks and injected Git configuration without altering global workflow", async () => {
    const f = await fixture(); const hooks = path.join(f.root, "inherited hooks"); await mkdir(hooks);
    const marker = path.join(f.root, "unexpected hook"); await writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\nprintf unsafe > '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 });
    git(f.repository, ["config", "core.hooksPath", hooks]);
    vi.stubEnv("GIT_DIR", path.join(f.root, "wrong git")); vi.stubEnv("GIT_WORK_TREE", path.join(f.root, "wrong worktree"));
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.worktree"); vi.stubEnv("GIT_CONFIG_VALUE_0", path.join(f.root, "redirected"));
    const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n"); await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(f.repository, ["config", "--get", "core.hooksPath"])).toBe(hooks); expect(process.env.GIT_CONFIG_COUNT).toBe("1");
  });

  it.skipIf(process.platform === "win32")("rejects symbolic-link roots and managed parent paths", async () => {
    const f = await fixture(); const adapter = manager(f.root); const alias = path.join(f.root, "alias"); await symlink(f.repository, alias);
    await expect(adapter.prepareRepository({ ...f.project, localPath: alias }, operation())).rejects.toThrow("ordinary directory");
    const outside = path.join(f.root, "outside"); await mkdir(outside); await symlink(outside, path.join(f.repository, ".worktrees"));
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("ordinary directory"); expect(await readdir(outside)).toEqual([]);
  });

  it("rejects pre-cancelled work before creating any resources", async () => {
    const f = await fixture(); const adapter = manager(f.root); const controller = new AbortController(); controller.abort(new Error("cancelled"));
    const op = createOperation({ signal: controller.signal }); operations.push(op);
    await expect(adapter.prepareWorktree(f.project, f.owner, op)).rejects.toBe(op.signal.reason);
    expect(await readdir(f.repository)).not.toContain(".worktrees");
  });

  it("checks exact retained refs and reports branch namespace or checkout conflicts before reservation", async () => {
    const f = await fixture(); const adapter = manager(f.root); const branch = `daynight/${ids.taskId}`;
    git(f.repository, ["branch", `${branch}-suffix`]);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation()); expect(binding.branch).toBe(branch);
    await adapter.removeWorktree(f.project, f.owner, operation()); git(f.repository, ["branch", "-D", branch]); git(f.repository, ["branch", `${branch}/child`]);
    await expect(adapter.prepareWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("branch namespace");
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    git(f.repository, ["branch", "-D", `${branch}/child`]); git(f.repository, ["branch", branch]);
    const other = path.join(f.root, "other worktree"); git(f.repository, ["worktree", "add", other, branch]);
    await expect(adapter.prepareWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("already checked out");
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(path.join(other, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("retains changed Git pointers and permits terminal cleanup after a branch change", async () => {
    const f = await fixture(), adapter = manager(f.root), binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const pointer = path.join(binding.worktreePath, ".git"), original = await readFile(pointer, "utf8");
    await rm(pointer); await writeFile(pointer, `gitdir: ${path.join(f.repository, ".git")}\n`);
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer has changed");
    await rm(pointer); await writeFile(pointer, original);
    git(binding.worktreePath, ["checkout", "-b", "other-task"]);
    await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow("original task branch");
    await adapter.removeWorktree(f.project, f.owner, operation());
    expect(git(f.repository, ["show-ref", "--verify", "refs/heads/other-task"])).toContain("other-task");
  });

  it("finishes a missing leaf's owned registration without globally pruning unrelated worktrees", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const other = path.join(f.root, "unrelated worktree"); git(f.repository, ["worktree", "add", "--detach", "--lock", "--reason", "unrelated", other, "HEAD"]);
    await rm(binding.worktreePath, { recursive: true }); await rm(path.dirname(binding.worktreePath), { recursive: true });
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).toContain(path.normalize(other)); expect(await readFile(path.join(other, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it.each([
    { command: "clone", stream: "stdout" },
    { command: "fetch", stream: "stderr" },
    { command: "add", stream: "stdout" },
    { command: "update-ref", stream: "stderr" },
  ])("retains $command cancellation until its real $stream closes", async ({ command, stream }) => {
    const f = await fixture(), ready = path.join(f.root, "held-ready"), release = path.join(f.root, "held-release");
    const leaf = path.join(f.root, "held-leaf.mjs"), wrapper = path.join(f.root, "held-command.mjs");
    await writeFile(leaf, `import { existsSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ready)}, 'ready');\nconst poll = setInterval(() => { if (existsSync(${JSON.stringify(release)})) { clearInterval(poll); process.exit(0); } }, 20);\nsetTimeout(() => process.exit(1), 30000).unref();\n`);
    await writeFile(wrapper, `import { spawn } from 'node:child_process';\nconst leaf = spawn(process.execPath, [${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', ${stream === "stdout" ? "'inherit'" : "'ignore'"}, ${stream === "stderr" ? "'inherit'" : "'ignore'"}], windowsHide: true });\nleaf.unref();\n`);
    const observed = Promise.withResolvers<import("../../../src/commands/worker/worktrees.js").WorkerGitPending>();
    const signal = new AbortController();
    const op = createOperation({ signal: signal.signal }); operations.push(op);
    const adapter = manager(f.root, { reportPending: event => { if (event.command === (command === "add" ? "worktree-add" : command)) observed.resolve(event); } });
    controlledGit.command = command; controlledGit.script = wrapper;
    const project = command === "clone" ? { ...f.project, localPath: path.join(f.root, "cloned") } : f.project;
    const result = (command === "clone" ? adapter.prepareRepository(project, op) : adapter.prepareWorktree(project, f.owner, op)).then(() => null, error => error);
    const contains = (value: unknown, target: unknown): boolean => value === target || value instanceof Error && (contains(value.cause, target) || value instanceof AggregateError && value.errors.some((entry: unknown) => contains(entry, target)));
    try {
      await vi.waitFor(async () => { expect(controlledGit.child).toBeDefined(); expect(await readFile(ready, "utf8")).toBe("ready"); }, { timeout: 12000, interval: 10 });
      const child = controlledGit.child!;
      await vi.waitFor(() => expect(child.exitCode !== null || child.signalCode !== null).toBe(true), { timeout: 12000, interval: 10 });
      const cancellation = new Error(`cancel ${command}`); signal.abort(cancellation);
      const event = await Promise.race([observed.promise, result.then(error => { throw error ?? new Error("Mutation completed before reporting pending cleanup."); })]);
      expect(event).toMatchObject({ projectId: f.project.projectId, command: command === "add" ? "worktree-add" : command, error: { code: "repository_git_cleanup_pending" } });
      if (command !== "clone") expect(event.owner).toEqual(f.owner);
      expect(contains(event.error, op.signal.reason)).toBe(true);
      let finished = false; void result.then(() => { finished = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(finished).toBe(false);
      expect((await readdir(path.join(f.root, "temporary"))).filter(name => name.startsWith("git-hooks-"))).toHaveLength(1);
      await writeFile(release, "release");
      const error = await result;
      expect(contains(error, op.signal.reason)).toBe(true);
      expect(contains(error, cancellation)).toBe(true);
    } finally {
      signal.abort(new Error("fixture cleanup"));
      await writeFile(release, "release");
      await result;
      controlledGit.script = undefined;
    }
  }, 45_000);

  it("waits for preparation before deleting hooks even when no owned command has started", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let scopedSignal: AbortSignal | undefined;
    const start = vi.fn<typeof startOwnedRepositoryGit>(startOwnedRepositoryGit);
    const adapter = manager(f.root, { startOwnedGit: start, runGit: async (cwd, args, op, options) => {
      if (args.includes("--is-bare-repository")) {
        scopedSignal = op.signal; entered.resolve(); await release.promise; op.check();
      }
      return runRepositoryGit(cwd, args, op, options);
    } });
    const preparation = adapter.prepareRepository(f.project, operation()).then(() => null, error => error);
    try {
      await entered.promise;
      expect(start).not.toHaveBeenCalled();
      const closing = adapter.dispose(); let closed = false; void closing.then(() => { closed = true; });
      expect(scopedSignal?.aborted).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
      expect((await readdir(path.join(f.root, "temporary"))).filter(name => name.startsWith("git-hooks-"))).toHaveLength(1);
      await expect(adapter.prepareRepository(f.project, operation())).rejects.toThrow("closing");
      release.resolve();
      expect(await preparation).toMatchObject({ message: "Worker Git manager is closing." });
      await closing;
      expect(await readdir(path.join(f.root, "temporary"))).toEqual([]);
    } finally { release.resolve(); await preparation; await adapter.dispose(); }
  });

  it("joins pending mutations and retains command, cleanup and reporting errors on disposal", async () => {
    const f = await fixture();
    const original = new Error("original command failure"), late = new Error("late cleanup failure"), reporting = new Error("pending report failed"), settledReporting = new Error("settled report failed");
    const pendingError = new RepositoryGitCleanupPendingError([], original);
    const settlement = Promise.withResolvers<GitSettlement>(), reported = Promise.withResolvers<void>();
    const requestStop = vi.fn();
    const pendingEvents: Parameters<NonNullable<Parameters<typeof createWorkerGitManager>[0]["reportPending"]>>[0][] = [];
    const settledEvents: typeof pendingEvents = [];
    const adapter = manager(f.root, {
      startOwnedGit: (cwd, args, op, options) => {
        if (!args.includes("fetch")) return startOwnedRepositoryGit(cwd, args, op, options);
        return { outcome: Promise.resolve({ kind: "cleanup-pending", error: pendingError }), joined: settlement.promise, requestStop };
      },
      reportPending: event => { pendingEvents.push(event); reported.resolve(); throw reporting; },
      reportSettled: event => { settledEvents.push(event); throw settledReporting; },
    });
    const preparation = adapter.prepareWorktree(f.project, f.owner, operation()).then(() => null, error => error);
    try {
      await reported.promise;
      expect(pendingEvents).toHaveLength(1);
      expect(pendingEvents[0]).toMatchObject({ projectId: f.project.projectId, owner: f.owner, command: "fetch", error: pendingError, attemptId: expect.any(String) });
      const closing = adapter.dispose(); let closed = false, returned = false;
      void closing.then(() => { closed = true; }); void preparation.then(() => { returned = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(requestStop).toHaveBeenCalledOnce();
      expect(closed).toBe(false); expect(returned).toBe(false);
      expect((await readdir(path.join(f.root, "temporary"))).filter(name => name.startsWith("git-hooks-"))).toHaveLength(1);
      settlement.resolve({ kind: "local-closed", cleanupErrors: [late] });
      const error = await preparation;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ cause: pendingError, errors: expect.arrayContaining([pendingError, late, reporting, settledReporting]) });
      expect(pendingError.cause).toBe(original);
      expect(settledEvents).toEqual(pendingEvents);
      await closing;
      expect(await readdir(path.join(f.root, "temporary"))).toEqual([]);
    } finally { settlement.resolve({ kind: "local-closed", cleanupErrors: [] }); await preparation; await adapter.dispose(); }
  });

  it("uses one private hooks directory across concurrent tasks and disposes it", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    await Promise.all([adapter.prepareRepository(f.project, operation()), adapter.prepareRepository(f.project, operation())]);
    expect((await readdir(path.join(f.root, "temporary"))).filter((name) => name.startsWith("git-hooks-"))).toHaveLength(1);
    await adapter.dispose(); expect(await readdir(path.join(f.root, "temporary"))).toEqual([]);
  });

  it("returns the configured repository spelling while validating physical Git identities", async () => {
    const f = await fixture(); const adapter = manager(f.root); const project = { ...f.project, localPath: `${f.repository}${path.sep}.` };
    const binding = await adapter.prepareWorktree(project, f.owner, operation()); expect(binding.repositoryPath).toBe(project.localPath);
    expect(await adapter.verifyWorktree(project, f.owner, operation())).toEqual(binding);
  });

  it("rejects a changed task-local origin for execution while retaining terminal cleanup authority", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    git(f.repository, ["config", "extensions.worktreeConfig", "true"]);
    git(binding.worktreePath, ["config", "--worktree", "remote.origin.url", "https://example.com/foreign/repository.git"]);
    await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow("origin does not match");
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("origin does not match");
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  }, 30_000);

  it("uses backend-aware reftable HEAD for creation, dirty recovery and missing-leaf cleanup", async () => {
    const f = await fixture("reftable"); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(git(f.repository, ["rev-parse", "--show-ref-format"])).toBe("reftable");
    await writeFile(path.join(binding.worktreePath, "tracked.txt"), "dirty reftable\n");
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("dirty reftable\n");
    await rm(binding.worktreePath, { recursive: true }); await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("retains execution checks and permits terminal cleanup for detached reftable HEAD", async () => {
    const f = await fixture("reftable"), adapter = manager(f.root), binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    git(binding.worktreePath, ["checkout", "--detach", "HEAD"]);
    await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow();
    await adapter.removeWorktree(f.project, f.owner, operation());
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
