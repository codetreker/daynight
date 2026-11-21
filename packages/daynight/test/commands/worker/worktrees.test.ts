import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { RepositoryGitError, runRepositoryGit } from "../../../src/repository/git.js";
import { RepositoryGitCleanupPendingError, startOwnedRepositoryGit, type GitSettlement, type OwnedRepositoryGit } from "../../../src/repository/git-owned.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import type { WorkerCleanupPolicy } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { createWorktreeManifestStore } from "../../../src/commands/worker/worktrees/manifest.js";
import type { ResourceOwner, WorkerProject, WorktreeBinding } from "../../../src/commands/worker/types.js";
import { captureSynchronousDeadline } from "../../helpers/synchronous-deadline.js";
import { openExecutionResourceJournal } from "../../../src/commands/worker/execution-resource-journal.js";
import { withOwnedCommandLifecycle } from "../../../src/commands/worker/owned-command-lifecycle.js";
import { withinExecutionDeadline } from "../../../src/commands/worker/execution-scope.js";
import * as files from "../../../src/platform/files.js";
import { skipWithoutSymbolicLinks } from "../../helpers/symlink-support.js";

// Only the selected removal is replaced; every other directory removal runs the
// real implementation.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rmdir: vi.fn(actual.rmdir), readdir: vi.fn(actual.readdir), lstat: vi.fn(actual.lstat) };
});

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
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const busyError = (): NodeJS.ErrnoException => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
// Each cleanup member carries its own committed revision; a fixture names the
// one it exercises and leaves the other member unapplied.
const cleanupPolicy = (applied: Partial<WorkerCleanupPolicy>): WorkerCleanupPolicy =>
  ({ enableSudoCleanup: false, sudoRevision: null, enableWindowsProcessCleanup: false, windowsProcessRevision: null, ...applied });

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
      sources: { listSchedules: () => [], listWebTasks: () => [] } });
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
const repositoryFixture = async (refFormat: RefFormat) => {
  const source = await seed(refFormat);
  const root = await mkdtemp(path.join(scratch, "Git 用户 ")); directories.push(root);
  const repository = path.join(root, "repository");
  cpSync(source, repository, { recursive: true, force: false, errorOnExist: true });
  const project: WorkerProject = { projectId: ids.projectId, repoUrl: remote, localPath: repository };
  const owner: ResourceOwner = { projectId: ids.projectId, taskId: ids.taskId, claimId: ids.claimId, worktreeId: ids.worktreeId };
  return { root, repository, project, owner };
};
const fixture = async (refFormat: RefFormat = "files") => {
  const f = await repositoryFixture(refFormat);
  const bare = path.join(f.root, "origin.git");
  git(f.root, ["clone", "--bare", f.repository, bare]);
  git(f.repository, ["config", `url.${bare}.insteadOf`, remote]);
  return { ...f, bare };
};
type RepositoryFixture = Awaited<ReturnType<typeof repositoryFixture>>;
// Existing-worktree cases start with native registration and a published manifest.
const addRegisteredFixtureWorktree = (f: RepositoryFixture, commonDirectory: string, owner: ResourceOwner): WorktreeBinding => {
  const branch = `daynight/${owner.taskId}`;
  const worktreePath = path.join(f.repository, ".worktrees", "daynight", owner.worktreeId);
  git(f.repository, ["-c", `core.hooksPath=${path.join(f.root, "fixture-hooks")}`, "worktree", "add", "-b", branch, "--", worktreePath, "HEAD"]);
  createWorktreeManifestStore(commonDirectory).publish({ schemaVersion: 1, ...owner, directoryName: owner.worktreeId });
  return { repositoryPath: f.repository, commonDirectory, worktreePath, branch };
};
const prepareCleanupFixture = async (f: RepositoryFixture, adapter: ReturnType<typeof manager>): Promise<WorktreeBinding> => {
  const { commonDirectory } = await adapter.prepareRepository(f.project, operation());
  return addRegisteredFixtureWorktree(f, commonDirectory, f.owner);
};
// Git expands Windows drive aliases. Translate only that drive's physical root;
// resolving a junction or symlink within cwd must not remap unrelated paths.
const fixtureGitPath = (cwd: string, value: string): string => {
  const root = path.parse(cwd).root, observed = path.normalize(value);
  const relative = path.relative(realpathSync.native(root), observed);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? observed : path.resolve(root, relative);
};
const administrativeDirectory = (cwd: string): string => fixtureGitPath(cwd, git(cwd, ["rev-parse", "--absolute-git-dir"]));
const worktreePaths = (cwd: string): string[] => git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((field) => field.startsWith("worktree ")).map((field) => fixtureGitPath(cwd, field.slice(9)));
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
  vi.mocked(rmdir).mockImplementation(actualFs.rmdir);
  vi.mocked(readdir).mockImplementation(actualFs.readdir);
  vi.mocked(lstat).mockImplementation(actualFs.lstat);
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

  it("rejects mismatches on either manifest ownership key", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
    const other = changedClaim(f.owner);
    for (const owner of [{ ...f.owner, worktreeId: other.worktreeId }, { ...f.owner, claimId: other.claimId }]) {
      await expect(adapter.verifyWorktree(f.project, owner, operation())).rejects.toThrow("belongs to another original resource");
    }
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("distinguishes a bare repository from a non-bare Git administrative directory", async () => {
    const f = await fixture(), adapter = manager(f.root);
    await expect(adapter.prepareRepository({ ...f.project, localPath: f.bare }, operation())).rejects.toThrow("must have a primary worktree");
    const error = await adapter.prepareRepository({ ...f.project, localPath: path.join(f.repository, ".git") }, operation()).catch(reason => reason);
    expect(error).toBeInstanceOf(RepositoryGitError);
    expect(error).toMatchObject({ exitCode: 128 });
    expect(error.message).not.toContain("must have a primary worktree");
  });

  it("checks the native root and origin before observing a separate Git directory", async () => {
    const f = await repositoryFixture("files");
    const root = path.join(f.root, "checkout");
    const common = path.join(f.root, "git-metadata"), nested = path.join(root, "nested");
    await rename(f.repository, root);
    git(root, ["init", "--separate-git-dir", common]);
    await mkdir(nested);
    const queries: string[][] = [];
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      queries.push(args.slice(4));
      return runRepositoryGit(cwd, args, op, options);
    } });
    const project = { ...f.project, localPath: root };
    const rootQuery = ["rev-parse", "--is-bare-repository", "--show-toplevel"];
    const originQuery = ["config", "--get-all", "remote.origin.url"];
    await expect(adapter.prepareRepository({ ...project, localPath: nested }, operation())).rejects.toThrow("must identify its worktree root");
    expect(queries.splice(0)).toEqual([rootQuery]);
    await expect(adapter.prepareRepository({ ...project, repoUrl: "https://example.com/other.git" }, operation())).rejects.toThrow("origin does not match");
    expect(queries.splice(0)).toEqual([rootQuery, originQuery]);
    const result = await adapter.prepareRepository(project, operation());
    expect(result).toMatchObject({ root, commonDirectory: await realpath(common) });
    expect(queries.slice(0, 3)).toEqual([rootQuery, originQuery, ["rev-parse", "--path-format=absolute", "--git-common-dir"]]);
  });

  it.skipIf(process.platform === "win32")("rejects line breaks in a Git-resolved root instead of truncating the path", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    const parent = path.join(f.root, "real\nparent"), alias = path.join(f.root, "alias");
    await mkdir(parent);
    await rename(f.repository, path.join(parent, "repo"));
    await symlink(parent, alias);
    const root = path.join(alias, "repo");
    expect(git(root, ["rev-parse", "--show-toplevel"])).toContain("\n");
    await expect(adapter.prepareRepository({ ...f.project, localPath: root }, operation())).rejects.toThrow("Git root must be an absolute path without line breaks or NUL");
  });

  it("finds an owned worktree after a lost binding without creating or resetting one", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    await expect(adapter.findWorktree(f.project, f.owner, operation())).rejects.toThrow("manifest is missing");
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const binding = await prepareCleanupFixture(f, adapter);
    await writeFile(path.join(binding.worktreePath, "tracked.txt"), "retained dirty work\n");
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("retained dirty work\n");
    await expect(adapter.findWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("manifest is missing");
  });

  it("does not report a removed original when Git moved its branch registration", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
    const moved = path.join(f.root, "moved-worktree");
    git(f.repository, ["worktree", "move", binding.worktreePath, moved]);
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.isOriginalWorktreeAbsent(f.project, f.owner, binding.worktreePath, operation())).toBe(false);
    expect(await readFile(path.join(moved, "tracked.txt"), "utf8")).toBe("original\n");
    git(f.repository, ["worktree", "remove", moved]);
    expect(await adapter.isOriginalWorktreeAbsent(f.project, f.owner, binding.worktreePath, operation())).toBe(true);
  });

  it("retains a moved original registration even after its HEAD is detached", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
    const moved = path.join(f.root, "moved-detached-worktree");
    git(f.repository, ["worktree", "move", binding.worktreePath, moved]);
    git(moved, ["checkout", "--detach"]);
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.isOriginalWorktreeAbsent(f.project, f.owner, binding.worktreePath, operation())).toBe(false);
    expect(worktreePaths(f.repository)).toContain(path.normalize(moved));
    expect(await readFile(path.join(moved, "tracked.txt"), "utf8")).toBe("original\n");
    git(f.repository, ["worktree", "remove", moved]);
    expect(await adapter.isOriginalWorktreeAbsent(f.project, f.owner, binding.worktreePath, operation())).toBe(true);
  });

  it("recognizes a verified successor in a different worktree directory", async () => {
    const f = await fixture(), adapter = manager(f.root);
    const original = await adapter.prepareWorktree(f.project, f.owner, operation());
    await adapter.removeWorktree(f.project, f.owner, {});
    await adapter.retireWorktreeManifest(f.project, f.owner, operation());
    const successor = changedClaim(f.owner);
    const next = await adapter.prepareWorktree(f.project, successor, operation());
    expect(next.worktreePath).not.toBe(original.worktreePath);
    expect(git(next.worktreePath, ["branch", "--show-current"])).toBe(`daynight/${f.owner.taskId}`);
    expect(await adapter.isOriginalWorktreeAbsent(f.project, f.owner, original.worktreePath, operation())).toBe(true);
    expect(await readFile(path.join(next.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(worktreePaths(f.repository)).toContain(path.normalize(next.worktreePath));
  });

  it("does not accept an unrelated manifest as proof of the successor", async () => {
    const f = await fixture(), adapter = manager(f.root);
    const original = await adapter.prepareWorktree(f.project, f.owner, operation());
    await adapter.removeWorktree(f.project, f.owner, {});
    await adapter.retireWorktreeManifest(f.project, f.owner, operation());
    const successor = changedClaim(f.owner);
    const next = await adapter.prepareWorktree(f.project, successor, operation());
    const manifests = createWorktreeManifestStore(original.commonDirectory);
    const current = manifests.read(successor.worktreeId)!;
    manifests.remove(current);
    manifests.publish({ ...current, projectId: "88888888-8888-4888-8888-888888888888" });
    expect(await adapter.isOriginalWorktreeAbsent(f.project, f.owner, original.worktreePath, operation())).toBe(false);
    expect(await readFile(path.join(next.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(worktreePaths(f.repository)).toContain(path.normalize(next.worktreePath));
  });

  it("inspects linked metadata from the repository cwd with its original absolute context and operation budget", async () => {
    const f = await repositoryFixture("files");
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
    const binding = await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const failure = new Error("metadata query failed"); let inspect = false;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (inspect && args.some(arg => arg.startsWith("--work-tree=")) && args.includes(command)) throw failure;
      return runRepositoryGit(cwd, args, op, options);
    } });
    const binding = await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId); await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep");
    await expect(adapter.findWorktree(f.project, f.owner, operation())).rejects.toThrow("manifest is missing");
    expect(await readFile(path.join(target, "unrelated"), "utf8")).toBe("keep");
  });

  it("finds no claim resources in a repository without managed worktrees", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
  });

  it("can inspect managed worktrees belonging to another Project in the same repository", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    const foreignProject = { ...f.project, projectId: "99999999-9999-4999-8999-999999999999" };
    const foreignOwner = { ...f.owner, projectId: foreignProject.projectId };
    const binding = await prepareCleanupFixture({ ...f, project: foreignProject, owner: foreignOwner }, adapter);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    expect(await adapter.listWorktrees(f.project, operation(), false, true)).toEqual([{ owner: foreignOwner, binding }]);
  });

  it.skipIf(skipWithoutSymbolicLinks)("only treats an absent repository as empty when explicitly requested, rejecting a dangling link", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    const absent = { ...f.project, localPath: path.join(f.root, "missing", "repo") };
    await expect(adapter.listWorktrees(absent, operation())).rejects.toThrow("missing");
    await expect(adapter.listWorktrees(absent, operation(), true)).resolves.toEqual([]);
    const dangling = path.join(f.root, "dangling"); await symlink(path.join(f.root, "missing"), dangling);
    await expect(adapter.listWorktrees({ ...f.project, localPath: dangling }, operation(), true)).rejects.toThrow(/symbolic link/);
  });

  describe("claim resource discovery", () => {
    const prepare = async () => {
      const f = await repositoryFixture("files"); const adapter = manager(f.root);
      const { commonDirectory } = await adapter.prepareRepository(f.project, operation());
      const first = addRegisteredFixtureWorktree(f, commonDirectory, f.owner);
      const otherOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", worktreeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
      const second = addRegisteredFixtureWorktree(f, commonDirectory, otherOwner);
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
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    const { commonDirectory } = await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep\n");
    const healthyOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", worktreeId: "99999999-9999-4999-8999-999999999999" };
    const healthy = addRegisteredFixtureWorktree(f, commonDirectory, healthyOwner);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: healthyOwner, binding: healthy }]);
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("manifest is missing");
    expect(await readFile(path.join(target, "unrelated"), "utf8")).toBe("keep\n");
  });

  it("settles published empty reservations without inferring an absent manifest", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
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
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    await adapter.removeUnpublishedReservation(f.project, f.owner, operation());
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(target); await writeFile(path.join(target, "foreign"), "keep\n");
    await expect(adapter.removeUnpublishedReservation(f.project, f.owner, operation())).rejects.toThrow("not empty");
    expect(await readFile(path.join(target, "foreign"), "utf8")).toBe("keep\n");
  });

  it("completes reservation cleanup once a transient holder releases it", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    const owned = path.normalize(target);
    let attempts = 0;
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) === owned && ++attempts < 3) throw busyError();
      return actualFs.rmdir(entry, options);
    });
    await adapter.removeUnpublishedReservation(f.project, f.owner, operation());
    expect(attempts).toBe(3);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "win32")("terminates the processes holding a persistently busy reservation and completes cleanup", async () => {
    const f = await repositoryFixture("files");
    const stopped: string[] = [];
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "5" }),
      stopHoldingProcesses: async (target, _operation, options) => { stopped.push(path.normalize(target)); const holder = { pid: 915, image: "node.exe", directory: target }; options?.onTerminated?.(holder); return { observed: [holder], terminated: [915] }; },
    });
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    const owned = path.normalize(target);
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) !== owned) return actualFs.rmdir(entry, options);
      // A reservation is held exactly as a registered worktree is; only
      // termination releases it.
      if (stopped.length === 0) throw busyError();
      return actualFs.rmdir(entry, options);
    });
    await adapter.removeUnpublishedReservation(f.project, f.owner, operation());
    expect(stopped).toEqual([owned]);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "win32")("retains a busy reservation and terminates nothing when the target is not applied", async () => {
    const f = await repositoryFixture("files");
    let stops = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: false, windowsProcessRevision: "5" }),
      stopHoldingProcesses: async () => { stops++; return { observed: [], terminated: [] }; },
    });
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    const owned = path.normalize(target);
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) !== owned) return actualFs.rmdir(entry, options);
      throw busyError();
    });
    await expect(adapter.removeUnpublishedReservation(f.project, f.owner, operation())).rejects.toThrow(/EBUSY/);
    expect(stops).toBe(0);
    expect((await lstat(target)).isDirectory()).toBe(true);
  });

  it("rejects a reservation replaced during the busy backoff instead of removing its replacement", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    // Prepared outside the reservation so it keeps its own inode; recreating the
    // same name in place can reuse the inode just freed and leave identity equal.
    const replacement = path.join(f.root, "replacement");
    await mkdir(replacement);
    await writeFile(path.join(replacement, "keep"), "retained\n");
    const owned = path.normalize(target);
    let attempts = 0;
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) !== owned) return actualFs.rmdir(entry, options);
      attempts++;
      await actualFs.rmdir(target);
      await actualFs.rename(replacement, target);
      throw busyError();
    });
    await expect(adapter.removeUnpublishedReservation(f.project, f.owner, operation())).rejects.toThrow(/changed before cleanup/);
    expect(attempts).toBe(1);
    expect(await readFile(path.join(target, "keep"), "utf8")).toBe("retained\n");
  });

  it("rejects a reservation replaced during the registration scan of a busy retry", async () => {
    const f = await repositoryFixture("files"), adapter = manager(f.root);
    await adapter.prepareRepository(f.project, operation());
    const target = path.join(f.repository, ".worktrees", "daynight", ids.worktreeId);
    await mkdir(target, { recursive: true });
    const replacement = path.join(f.root, "replacement");
    await mkdir(replacement);
    await writeFile(path.join(replacement, "keep"), "retained\n");
    const owned = path.normalize(target);
    let attempts = 0;
    let swapped = false;
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) !== owned) return actualFs.rmdir(entry, options);
      attempts++;
      // Armed only now, so the retry's first identity check still passes and the
      // swap lands inside its registration scan.
      registrationBoundary.afterRead = () => {
        if (swapped) return;
        swapped = true;
        rmdirSync(target);
        renameSync(replacement, target);
      };
      throw busyError();
    });
    await expect(adapter.removeUnpublishedReservation(f.project, f.owner, operation())).rejects.toThrow(/changed before cleanup/);
    expect(swapped).toBe(true);
    expect(attempts).toBe(1);
    expect(await readFile(path.join(target, "keep"), "utf8")).toBe("retained\n");
  });

  it.skipIf(skipWithoutSymbolicLinks)("rejects symlink parents when cleaning a reservation by task identity", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    const outside = path.join(f.root, "outside");
    await mkdir(path.join(outside, ids.taskId), { recursive: true });
    await mkdir(path.join(f.repository, ".worktrees"));
    await symlink(outside, path.join(f.repository, ".worktrees", "daynight"));
    await expect(adapter.removeEmptyReservation(f.project, ids.taskId, operation())).rejects.toThrow("ordinary directory");
    expect((await lstat(path.join(outside, ids.taskId))).isDirectory()).toBe(true);
  });



  describe("partial resource scans", () => {
    const scanFixture = async () => {
      const f = await repositoryFixture("files");
      const adapter = manager(f.root);
      const { commonDirectory } = await adapter.prepareRepository(f.project, operation());
      const addRegisteredWorktree = (owner: ResourceOwner): WorktreeBinding => addRegisteredFixtureWorktree(f, commonDirectory, owner);
      return { f, adapter, addRegisteredWorktree };
    };

    it.each(["file", "leaf", "component-case"])("fences case-ambiguous missing Git targets: %s", async kind => {
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const owner = { ...f.owner, taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", worktreeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
      const binding = addRegisteredWorktree(owner);
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
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
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
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
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
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
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
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
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

    // Only the final-symlink alias needs a symbolic link of its own; the other
    // kinds reach the same code through a junction, which needs no privilege.
    it.each(["duplicate", "duplicate-missing", ...(skipWithoutSymbolicLinks ? [] : ["duplicate-final-symlink"]), "unresolved", "unrelated", "unrelated-missing"])("proves physical registration targets with a %s manual alias", async kind => {
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
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
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const broken = addRegisteredWorktree(f.owner);
      const owner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "88888888-8888-4888-8888-888888888888", worktreeId: "99999999-9999-4999-8999-999999999999" };
      const healthy = addRegisteredWorktree(owner);
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

    it.each(["marker", "unknown-marker", "pointer", "duplicate", "unreadable", "commondir"])("isolates %s damage while preserving healthy observations", async kind => {
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
      const admin = administrativeDirectory(binding.worktreePath);
      const siblingOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "88888888-8888-4888-8888-888888888888", worktreeId: "99999999-9999-4999-8999-999999999999" };
      const sibling = addRegisteredWorktree(siblingOwner);
      if (kind === "marker") await writeFile(path.join(admin, "locked"), "daynight-worker:{");
      if (kind === "unknown-marker") await writeFile(path.join(admin, "locked"), "daynight-worker:{}");
      if (kind === "commondir") { await rm(path.join(admin, "commondir")); await mkdir(path.join(admin, "commondir")); }
      if (kind === "pointer") await writeFile(path.join(admin, "gitdir"), path.join(f.root, "foreign", ".git"));
      if (kind === "duplicate") cpSync(admin, `${admin}-duplicate`, { recursive: true });
      if (kind === "unreadable") { await rm(path.join(admin, "gitdir")); await mkdir(path.join(admin, "gitdir")); }
      const result = await adapter.scanWorktrees(f.project, operation());
      if (kind === "marker" || kind === "unknown-marker") {
        expect(result.unknown).toEqual([]);
        expect(result.quarantined).toEqual([{ owner: f.owner, error: expect.objectContaining({ message: expect.stringMatching(/Legacy Worker lock/) }) }]);
      } else {
        expect(result.unknown.length).toBeGreaterThan(0);
        expect(result.quarantined).toEqual([]);
      }
      if (kind !== "unreadable") {
        expect(result.validated).toEqual([{ owner: siblingOwner, binding: sibling }]);
        await expect(adapter.verifyWorktree(f.project, siblingOwner, operation())).resolves.toEqual(sibling);
      }
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow();
      expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    });

    it.each([...(skipWithoutSymbolicLinks ? [] : ["symlink"]), "file"])("keeps a registration replaced by a %s unknown without reading through it", async kind => {
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
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

    it.skipIf(skipWithoutSymbolicLinks).each(["manual", "missing"])("keeps unreadable Git pointers unknown with a %s marker", async marker => {
      const { f, adapter, addRegisteredWorktree } = await scanFixture();
      const binding = addRegisteredWorktree(f.owner);
      const siblingOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "88888888-8888-4888-8888-888888888888", worktreeId: "99999999-9999-4999-8999-999999999999" };
      addRegisteredWorktree(siblingOwner);
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
      const { f, adapter } = await scanFixture();
      await mkdir(path.join(f.repository, ".worktrees", "daynight", f.owner.taskId), { recursive: true });
      await writeFile(path.join(f.repository, ".worktrees", "daynight", f.owner.taskId, "keep"), "unowned");
      git(f.repository, ["worktree", "add", "--detach", path.join(f.root, "manual"), "HEAD"]);
      expect(await adapter.scanWorktrees(f.project, operation())).toEqual({ enumerationComplete: true, validated: [], quarantined: [], unknown: [] });
    });

    it("propagates an expired deadline without turning it into empty coverage", async () => {
      const f = await repositoryFixture("files"), adapter = manager(f.root);
      const op = createOperation({ limits: { totalMs: 1 } }); operations.push(op);
      await new Promise(resolve => setTimeout(resolve, 5));
      await expect(adapter.scanWorktrees(f.project, op)).rejects.toMatchObject({ kind: "deadline" });
    });

    it("propagates cancellation instead of reporting an empty or quarantined scan", async () => {
      const f = await repositoryFixture("files"), adapter = manager(f.root), abort = new AbortController();
      abort.abort(); const op = createOperation({ signal: abort.signal }); operations.push(op);
      await expect(adapter.scanWorktrees(f.project, op)).rejects.toMatchObject({ kind: "cancelled" });
    });
  });

  it("limits discovered resources to the requested project's static ownership", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    const otherProject = { ...f.project, projectId: "88888888-8888-4888-8888-888888888888" };
    const otherOwner = { ...f.owner, projectId: otherProject.projectId };
    const binding = await prepareCleanupFixture({ ...f, project: otherProject, owner: otherOwner }, adapter);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    expect(await adapter.listWorktrees(otherProject, operation())).toEqual([{ owner: otherOwner, binding }]);
  });

  it("validates an existing root and keeps dirty repository work", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    await writeFile(path.join(f.repository, "tracked.txt"), "uncommitted\n"); await writeFile(path.join(f.repository, "untracked.txt"), "retained\n");
    const actual = await adapter.prepareRepository(f.project, operation());
    expect(actual.root).toBe(f.repository); expect(actual.commonDirectory).toBe(await realpath(path.join(f.repository, ".git")));
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
    const f = await fixture();
    const blocker = path.join(f.root, "block-fetch.cjs"), ready = path.join(f.root, "upload-pack-ready"), release = path.join(f.root, "upload-pack-release");
    await writeFile(blocker, [
      'const { existsSync, writeFileSync } = require("node:fs");',
      `setInterval(() => { if (existsSync(${JSON.stringify(release)})) process.exit(0); }, 10);`,
      'setTimeout(() => process.exit(86), 12000).unref();',
      `writeFileSync(${JSON.stringify(ready)}, "ready");`,
      "",
    ].join("\n"));
    git(f.repository, ["config", "remote.origin.uploadpack", `\"${process.execPath}\" \"${blocker}\"`]);
    const timeoutMs = 1500;
    let timer: ReturnType<typeof captureSynchronousDeadline<OwnedRepositoryGit>> | undefined;
    const adapter = manager(f.root, {
      startOwnedGit: (cwd, args, op, options) => {
        if (!args.includes("fetch")) return startOwnedRepositoryGit(cwd, args, op, options);
        if (timer !== undefined) throw new Error("Unexpected second fetch in the deadline fixture.");
        timer = captureSynchronousDeadline(() => startOwnedRepositoryGit(cwd, args, op, { ...options, timeoutMs }));
        return timer.result;
      },
    });
    const preparation = reservation(adapter.prepareWorktree(f.project, f.owner, operation())).then(() => null, (error: unknown) => error);
    try {
      const captured = await vi.waitFor(async () => {
        expect(await readFile(ready, "utf8")).toBe("ready");
        if (timer === undefined) throw new Error("Fetch timer was not captured.");
        return timer;
      }, { timeout: 5_000, interval: 10 });
      expect(captured.count).toBe(1);
      expect(captured.requested).toBe(timeoutMs);
      let settlement: GitSettlement | undefined;
      void captured.result.joined.then(saved => { settlement = saved; });
      captured.markReady();
      await captured.expire();
      await vi.waitFor(() => expect(settlement).toMatchObject({ kind: "local-closed" }), { timeout: 4_000, interval: 10 });
      const failure = await preparation;
      expect(failure).toBeInstanceOf(Error);
      expect(errorText(failure)).toContain("deadline exceeded");
      expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
      expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
      expect(privateBases(f.repository)).toBe("");
    } finally {
      try {
        await writeFile(release, "release");
        timer?.result.requestStop();
        await Promise.allSettled([preparation, timer?.result.joined]);
      } finally { timer?.restore(); }
    }
  }, 20_000);

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
    const f = await repositoryFixture("files"); const failure = new Error("controlled partial filesystem removal"); let partial = true;
    const adapter = manager(f.root, { removeDirectory: async (target, options) => { await rm(target, options); if (partial) { partial = false; throw failure; } } });
    const binding = await prepareCleanupFixture(f, adapter);
    const pointer = await readFile(path.join(binding.worktreePath, ".git"), "utf8");
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toBe(failure);
    expect(createWorktreeManifestStore(path.join(f.repository, ".git")).read(ids.worktreeId)).toMatchObject(f.owner);
    expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toBe(pointer);
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("completes cleanup when the task worktree root is transiently busy", async () => {
    const f = await repositoryFixture("files");
    const adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    let attempts = 0;
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) === root && ++attempts < 3) throw busyError();
      return actualFs.rmdir(target, options);
    });
    await adapter.removeWorktree(f.project, f.owner, operation());
    expect(attempts).toBe(3);
    expect(worktreePaths(f.repository)).not.toContain(root);
    expect(await lstat(root).catch(() => null)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("terminates the processes holding a persistently busy worktree and completes cleanup", async () => {
    const f = await repositoryFixture("files");
    const stopped: string[] = [];
    let attempts = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "7" }),
      stopHoldingProcesses: async (target, _operation, options) => { stopped.push(path.normalize(target)); const holder = { pid: 4242, image: "node.exe", directory: target }; options?.onTerminated?.(holder); return { observed: [holder], terminated: [4242] }; },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      // Busy through every backoff, so only termination can unblock removal.
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      attempts++;
      if (stopped.length === 0) throw busyError();
      return actualFs.rmdir(target, options);
    });
    await adapter.removeWorktree(f.project, f.owner, operation());
    expect(stopped).toEqual([root]);
    expect(attempts).toBe(7);
    expect(worktreePaths(f.repository)).not.toContain(root);
    expect(await lstat(root).catch(() => null)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("refuses to remove when ownership changes while the holders are being terminated", async () => {
    const f = await repositoryFixture("files");
    const manifestPath = path.join(f.repository, ".git", "daynight", "worktrees", `${ids.worktreeId}.json`);
    let stops = 0, removals = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "9" }),
      stopHoldingProcesses: async (target, _operation, options) => {
        stops++;
        // Termination is asynchronous; the worktree this cleanup proved it
        // owns stops being its own while the processes are going away.
        rmSync(manifestPath, { force: true });
        const holder = { pid: 916, image: "node.exe", directory: target };
        options?.onTerminated?.(holder);
        return { observed: [holder], terminated: [916] };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      removals++;
      if (stops === 0) throw busyError();
      return actualFs.rmdir(target, options);
    });
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as Error);
    expect(stops).toBe(1);
    expect(errorText(error)).toContain("manifest changed");
    // The retry must not have removed anything after the proof became invalid.
    // Both the admission that follows termination and the removal sequence's
    // own verifier enforce this, so the case holds the behavior rather than
    // any single guard.
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect(worktreePaths(f.repository)).toContain(root);
  });

  it.skipIf(process.platform !== "win32")("terminates no holder when the busy root is replaced during the metadata read", async () => {
    const f = await repositoryFixture("files");
    let stops = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "9" }),
      stopHoldingProcesses: async (target, _operation, options) => { stops++; const holder = { pid: 914, image: "node.exe", directory: target }; options?.onTerminated?.(holder); return { observed: [holder], terminated: [914] }; },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    const replacement = path.join(f.root, "replacement");
    await mkdir(replacement);
    let attempts = 0, armed = false, swapped = false;
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      // Armed only once the busy retries are exhausted, so the swap lands in
      // the asynchronous reads of the admission that precedes termination,
      // after its first identity check has already passed.
      if (++attempts >= 6) armed = true;
      throw busyError();
    });
    vi.mocked(readdir).mockImplementation((async (entry: Parameters<typeof actualFs.readdir>[0], options: Parameters<typeof actualFs.readdir>[1]) => {
      const result = await actualFs.readdir(entry, options);
      if (armed && !swapped && path.normalize(String(entry)) === root) {
        swapped = true;
        rmdirSync(root);
        renameSync(replacement, root);
      }
      return result;
    }) as typeof actualFs.readdir);
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as Error);
    expect(swapped).toBe(true);
    expect(errorText(error)).toContain("changed during cleanup");
    // The replacement is unrelated to this worktree, so nothing in it may be
    // terminated even though it satisfies every check taken before the reads.
    expect(stops).toBe(0);
  });

  it.skipIf(process.platform !== "win32")("retains a busy worktree and its registration when the target is not applied", async () => {
    const f = await repositoryFixture("files");
    let stops = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: false, windowsProcessRevision: "7" }),
      stopHoldingProcesses: async () => { stops++; return { observed: [], terminated: [] }; },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      throw busyError();
    });
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow(/EBUSY/);
    expect(stops).toBe(0);
    expect(worktreePaths(f.repository)).toContain(root);
  });

  it.skipIf(process.platform !== "win32")("retains the original busy error when the worktree stays busy after termination", async () => {
    const f = await repositoryFixture("files");
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "7" }),
      // A holder that keeps an open file rather than a working directory is
      // not reported, so the retry observes the same obstacle.
      stopHoldingProcesses: async () => ({ observed: [], terminated: [] }),
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      throw busyError();
    });
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as AggregateError);
    expect(errorText(error)).toContain("EBUSY");
    expect(errorText(error)).toContain("configuration revision 7");
    expect(errorText(error)).toContain("No holder was terminated.");
    expect(worktreePaths(f.repository)).toContain(root);
  });

  it.skipIf(process.platform !== "win32")("reports a nested reservation's terminations with the attempt that reached it", async () => {
    const f = await repositoryFixture("files");
    const controller = new AbortController();
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "5" }),
      stopHoldingProcesses: async (target, _operation, options) => {
        const holder = { pid: 903, image: "node.exe", directory: target };
        options?.onTerminated?.(holder);
        controller.abort(new Error("cleanup cancelled"));
        return { observed: [holder], terminated: [903] };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const admin = await realpath(administrativeDirectory(binding.worktreePath));
    // Without its Git registration the directory is an unregistered
    // reservation, so the removal reaches it through the nested path rather
    // than the main one. The record is the attempt's, not that step's.
    await rm(admin, { recursive: true, force: true });
    for (const entry of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, entry), { recursive: true, force: true });
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      throw busyError();
    });
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(failure => failure as AggregateError);
    expect(errorText(error)).toContain("Terminated 1 holder process tree: node.exe (903).");
  });

  it.skipIf(process.platform !== "win32")("names the terminated holders when cancellation ends the attempt instead of the removal", async () => {
    const f = await repositoryFixture("files");
    const controller = new AbortController();
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "7" }),
      stopHoldingProcesses: async (target, _operation, options) => {
        const holder = { pid: 801, image: "node.exe", directory: target };
        // Reported before the cancellation, which is the whole point: the
        // process is gone and this attempt will never return a result.
        options?.onTerminated?.(holder);
        controller.abort(new Error("cleanup cancelled"));
        return { observed: [holder], terminated: [801] };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      throw busyError();
    });
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(failure => failure as AggregateError);
    expect(errorText(error)).toContain("Terminated 1 holder process tree: node.exe (801).");
    expect(errorText(error)).toContain("cancel");
  });

  it.skipIf(process.platform !== "win32")("names the terminated holders when the attempt fails after the removal succeeded", async () => {
    const f = await repositoryFixture("files");
    const manifestPath = path.join(f.repository, ".git", "daynight", "worktrees", `${ids.worktreeId}.json`);
    let stopped = false;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "7" }),
      stopHoldingProcesses: async (target, _operation, options) => {
        stopped = true;
        const holder = { pid: 802, image: "node.exe", directory: target };
        options?.onTerminated?.(holder);
        return { observed: [holder], terminated: [802] };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      if (!stopped) throw busyError();
      const result = await actualFs.rmdir(target, options);
      // The removal itself succeeded. Everything that fails from here on does
      // so with the holder already terminated, which the local recovery scope
      // can no longer report.
      rmSync(manifestPath, { force: true });
      return result;
    });
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as AggregateError);
    expect(stopped).toBe(true);
    expect(errorText(error)).toContain("Terminated 1 holder process tree: node.exe (802).");
    expect(await lstat(root).catch(() => null)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("names the terminated holders when the worktree stays busy after termination", async () => {
    const f = await repositoryFixture("files");
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "7" }),
      // One holder kept an open file as well as its working directory, so the
      // tree stays busy after its working directory holders are gone.
      stopHoldingProcesses: async (target, _operation, options) => {
        const observed = [{ pid: 701, image: "node.exe", directory: target }, { pid: 702, image: "pwsh.exe", directory: target }, { pid: 703, image: "git.exe", directory: target }];
        for (const holder of [observed[0]!, observed[2]!]) options?.onTerminated?.(holder);
        return { observed, terminated: [701, 703] };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      throw busyError();
    });
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as AggregateError);
    expect(errorText(error)).toContain("EBUSY");
    // The termination cannot be undone, so the failure is the only record of
    // it the operator receives. Holders that survived are not claimed as ended.
    expect(errorText(error)).toContain("Terminated 2 holder process trees: node.exe (701), git.exe (703).");
    expect(errorText(error)).not.toContain("pwsh.exe");
    expect(worktreePaths(f.repository)).toContain(root);
  });

  it("rejects a worktree root replaced during the metadata read of a busy retry", async () => {
    const f = await repositoryFixture("files");
    const adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    const replacement = path.join(f.root, "replacement");
    await mkdir(replacement);
    await writeFile(path.join(replacement, "keep"), "retained\n");
    let attempts = 0;
    let armed = false;
    let swapped = false;
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) !== root) return actualFs.rmdir(entry, options);
      attempts++;
      // Armed only now, so the swap lands inside the retry's metadata read
      // rather than before its identity checks have run.
      armed = true;
      throw busyError();
    });
    vi.mocked(readdir).mockImplementation((async (entry: Parameters<typeof actualFs.readdir>[0], options: Parameters<typeof actualFs.readdir>[1]) => {
      const result = await actualFs.readdir(entry, options);
      if (armed && !swapped && path.normalize(String(entry)) === root) {
        swapped = true;
        rmdirSync(root);
        renameSync(replacement, root);
      }
      return result;
    }) as typeof actualFs.readdir);
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, operation()).catch(error => error))).toContain("changed during cleanup");
    expect(swapped).toBe(true);
    expect(attempts).toBe(1);
    expect(await readFile(path.join(root, "keep"), "utf8")).toBe("retained\n");
  });

  it("retains the task worktree root and its registration when it stays busy", async () => {
    const f = await repositoryFixture("files");
    const adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    let attempts = 0;
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      attempts++;
      throw busyError();
    });
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow(/EBUSY/);
    expect(attempts).toBe(6);
    expect(worktreePaths(f.repository)).toContain(root);
  });

  it.skipIf(process.platform === "win32")("uses the captured cleanup policy only for a verified permission obstacle", async () => {
    const f = await repositoryFixture("files"); let enabled = true, calls = 0;
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: enabled, sudoRevision: "42" })),
      removeDirectory: async () => { enabled = false; throw denied; },
      runShellRemoval: async (root, target) => { calls++; expect(root).toBe(f.repository); await rm(target, { recursive: true }); },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    await adapter.removeWorktree(f.project, f.owner, {});
    expect(calls).toBe(1); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    expect(git(f.repository, ["rev-parse", `refs/heads/${binding.branch}`])).not.toBe("");
  });

  it.skipIf(process.platform === "win32")("preserves both permission and actual shell errors", async () => {
    const f = await repositoryFixture("files"); const denied = Object.assign(new Error("ordinary denied"), { code: "EACCES" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "42" })),
      removeDirectory: async () => { throw denied; }, runShellRemoval: async () => { throw new Error("sudo denied"); },
    });
    await prepareCleanupFixture(f, adapter);
    const error = errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error));
    expect(error).toContain("ordinary denied"); expect(error).toContain("sudo denied"); expect(error).toContain("42");
  });

  it("does not elevate an ordinary I/O failure", async () => {
    const f = await repositoryFixture("files"); let calls = 0;
    const io = Object.assign(new Error("filesystem I/O failed"), { code: "EIO" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "42" })),
      removeDirectory: async () => { throw io; }, runShellRemoval: async () => { calls++; },
    });
    await prepareCleanupFixture(f, adapter);
    await expect(adapter.removeWorktree(f.project, f.owner, {})).rejects.toBe(io);
    expect(calls).toBe(0);
  });

  it.skipIf(process.platform !== "win32")("never invokes sudo on Windows even when enabled", async () => {
    const f = await repositoryFixture("files"); let calls = 0;
    const denied = Object.assign(new Error("ordinary denied"), { code: "EACCES" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "42" })),
      removeDirectory: async () => { throw denied; }, runShellRemoval: async () => { calls++; },
    });
    await prepareCleanupFixture(f, adapter);
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("ordinary denied");
    expect(calls).toBe(0);
  });

  it.skipIf(process.platform === "win32")("retains registration and both errors when privileged removal is partial", async () => {
    const f = await repositoryFixture("files");
    const denied = Object.assign(new Error("ordinary denied"), { code: "EACCES" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "42" })),
      removeDirectory: async () => { throw denied; },
      runShellRemoval: async (_root, target) => { await rm(path.join(target, "tracked.txt")); throw new Error("partial shell removal"); },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const error = errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error));
    expect(error).toContain("ordinary denied"); expect(error).toContain("partial shell removal");
    expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
  });

  it.skipIf(process.platform === "win32")("retains an unattributable nonempty leaf after partial privileged removal", async () => {
    const f = await repositoryFixture("files"); let calls = 0;
    const denied = Object.assign(new Error("ordinary denied"), { code: "EACCES" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "42" })),
      removeDirectory: async () => { throw denied; },
      runShellRemoval: async (_root, target) => { calls++; await rm(path.join(target, ".git")); throw new Error("privileged partial removal"); },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const first = errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error));
    expect(first).toContain("ordinary denied"); expect(first).toContain("privileged partial removal");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
    const retry = errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error));
    expect(retry).toContain("Git pointer is missing");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
    expect(calls).toBe(1);
  });


  it.skipIf(process.platform === "win32")("retains the permission error when Git registration removal fails", async () => {
    const f = await repositoryFixture("files");
    const denied = Object.assign(new Error("ordinary denied"), { code: "EACCES" });
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "42" })),
      removeDirectory: async () => { throw denied; }, runShellRemoval: async (_root, target) => { await rm(target, { recursive: true }); },
      startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
        if (args.includes("worktree") && args.includes("remove")) throw new Error("registration failure");
        return runRepositoryGit(cwd, args, op, options);
      }),
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const error = errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error));
    expect(error).toContain("ordinary denied"); expect(error).toContain("registration failure");
    expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("removes a real root-owned directory through noninteractive sudo and clears Git registration", async () => {
    const f = await fixture();
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "17" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const owned = path.join(binding.worktreePath, "root-owned");
    execFileSync("sudo", ["-n", "mkdir", owned], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", owned], { timeout: 10000 });
    execFileSync("sudo", ["-n", "touch", path.join(owned, "file")], { timeout: 10000 });
    try {
      const outside = path.join(f.root, "outside"); await writeFile(outside, "keep");
      await symlink(outside, path.join(binding.worktreePath, "outside-link"));
      await link(outside, path.join(binding.worktreePath, "outside-hardlink"));
      await adapter.removeWorktree(f.project, f.owner, {});
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
      expect(await readFile(outside, "utf8")).toBe("keep");
      expect(git(f.repository, ["rev-parse", `refs/heads/${binding.branch}`])).not.toBe("");
    } finally { execFileSync("sudo", ["-n", "rm", "-rf", "--", owned], { timeout: 10000 }); }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("rechecks registration when the original Git pointer is inaccessible", async () => {
    const f = await fixture(); const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "20" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    execFileSync("sudo", ["-n", "chown", "0", binding.worktreePath], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", binding.worktreePath], { timeout: 10000 });
    try {
      await adapter.removeWorktree(f.project, f.owner, {});
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    } finally { execFileSync("sudo", ["-n", "rm", "-rf", "--", binding.worktreePath], { timeout: 10000 }); }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO)).each(["absolute", "relative"])("cleans an inaccessible owned worktree beside an unrelated stale registration with a %s pointer", async format => {
    const f = await fixture(); const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "20" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const stale = path.join(f.root, "stale worktree");
    git(f.repository, ["worktree", "add", "--detach", stale, "HEAD"]);
    if (format === "relative") {
      const admin = administrativeDirectory(stale);
      await writeFile(path.join(admin, "gitdir"), `${path.relative(admin, path.join(stale, ".git"))}\n`);
    }
    await rm(stale, { recursive: true });
    expect(worktreePaths(f.repository)).toContain(path.normalize(stale));
    execFileSync("sudo", ["-n", "chown", "0", binding.worktreePath], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", binding.worktreePath], { timeout: 10000 });
    try {
      await adapter.removeWorktree(f.project, f.owner, {});
      const registrations = worktreePaths(f.repository);
      expect(registrations).not.toContain(path.normalize(binding.worktreePath));
      expect(registrations).toContain(path.normalize(stale));
      expect(git(f.repository, ["rev-parse", `refs/heads/${binding.branch}`])).not.toBe("");
    } finally { execFileSync("sudo", ["-n", "rm", "-rf", "--", binding.worktreePath], { timeout: 10000 }); }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO)).each(["dangling", "missing-parent-traversal", "case-alias", "trailing-slash", "inaccessible-parent", "symlink-name", "hardlink-name"])("retains an inaccessible target when an unrelated registration has %s ambiguity", async kind => {
    const f = await fixture(); let calls = 0;
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "20" })), runShellRemoval: async () => { calls++; } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const stale = path.join(f.root, "stale worktree");
    git(f.repository, ["worktree", "add", "--detach", stale, "HEAD"]);
    const admin = administrativeDirectory(stale), gitdir = path.join(admin, "gitdir"), original = await readFile(gitdir, "utf8");
    await rm(stale, { recursive: true });
    let pointer: string;
    const rootOnly = path.join(f.root, "root-only");
    if (kind === "dangling") {
      const alias = path.join(f.root, "dangling"); await symlink(path.join(f.root, "missing"), alias);
      pointer = `${alias}/.git`;
    } else if (kind === "missing-parent-traversal") {
      pointer = `${f.root}/missing/../repository/.worktrees/daynight/${f.owner.worktreeId}/.git`;
    } else if (kind === "case-alias") pointer = `${binding.worktreePath}/.GIT`;
    else if (kind === "trailing-slash") pointer = `${binding.worktreePath}/.git/`;
    else if (kind === "inaccessible-parent") {
      execFileSync("sudo", ["-n", "mkdir", "-p", path.join(rootOnly, "child")], { timeout: 10000 });
      execFileSync("sudo", ["-n", "chmod", "700", rootOnly], { timeout: 10000 });
      pointer = `${rootOnly}/child/.git`;
    } else {
      pointer = path.join(f.root, "other-name");
      if (kind === "symlink-name") await symlink(path.join(binding.worktreePath, ".git"), pointer);
      else await link(path.join(binding.worktreePath, ".git"), pointer);
    }
    await writeFile(gitdir, `${pointer}\n`);
    execFileSync("sudo", ["-n", "chown", "0", binding.worktreePath], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", binding.worktreePath], { timeout: 10000 });
    try {
      const failure = await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      if (kind === "missing-parent-traversal") expect(errorText(failure)).toContain("unresolved parent traversal");
      if (kind === "case-alias" || kind.endsWith("-name")) expect(errorText(failure)).toContain("ambiguous or unexpected spelling");
      if (kind === "trailing-slash") expect(errorText(failure)).toContain("pointer path is invalid");
      expect(calls).toBe(0);
    } finally {
      execFileSync("sudo", ["-n", "chown", String(process.getuid!()), binding.worktreePath], { timeout: 10000 });
      if (kind === "inaccessible-parent") execFileSync("sudo", ["-n", "rm", "-rf", "--", rootOnly], { timeout: 10000 });
      await writeFile(gitdir, original);
    }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("rejects an inaccessible registration with an unprovable symlink traversal", async () => {
    const f = await fixture(); let calls = 0;
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "20" })), runShellRemoval: async () => { calls++; } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const admin = administrativeDirectory(binding.worktreePath), gitdir = path.join(admin, "gitdir"), original = await readFile(gitdir, "utf8");
    const parent = path.dirname(binding.worktreePath), alias = path.join(parent, "outside-alias"), outside = path.join(f.root, "outside");
    await mkdir(outside); await mkdir(path.join(f.root, path.basename(binding.worktreePath))); await symlink(outside, alias);
    await writeFile(gitdir, `${alias}/../${path.basename(binding.worktreePath)}/.git\n`);
    execFileSync("sudo", ["-n", "chown", "0", binding.worktreePath], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", binding.worktreePath], { timeout: 10000 });
    try {
      expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("registration is missing or ambiguous");
      expect(calls).toBe(0);
    } finally {
      execFileSync("sudo", ["-n", "chown", String(process.getuid!()), binding.worktreePath], { timeout: 10000 });
      await writeFile(gitdir, original);
    }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("rejects an inaccessible worktree with a physically different common directory", async () => {
    const f = await fixture(); let calls = 0;
    const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "20" })), runShellRemoval: async () => { calls++; } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const admin = administrativeDirectory(binding.worktreePath), common = path.join(admin, "commondir"), original = await readFile(common, "utf8");
    const outside = path.join(f.root, "outside"), alias = path.join(f.repository, "alias");
    await mkdir(outside); await mkdir(path.join(f.root, ".git")); await symlink(outside, alias);
    await writeFile(common, `${alias}/../.git\n`);
    execFileSync("sudo", ["-n", "chown", "0", binding.worktreePath], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", binding.worktreePath], { timeout: 10000 });
    try {
      expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("another Git repository");
      expect(calls).toBe(0);
    } finally {
      execFileSync("sudo", ["-n", "chown", String(process.getuid!()), binding.worktreePath], { timeout: 10000 });
      await writeFile(common, original);
    }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("accepts a verified relative Git pointer when the worktree is inaccessible", async () => {
    const f = await fixture(); const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "20" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const admin = administrativeDirectory(binding.worktreePath), gitdir = path.join(admin, "gitdir");
    await writeFile(gitdir, `${path.relative(admin, path.join(binding.worktreePath, ".git"))}\n`);
    execFileSync("sudo", ["-n", "chown", "0", binding.worktreePath], { timeout: 10000 });
    execFileSync("sudo", ["-n", "chmod", "700", binding.worktreePath], { timeout: 10000 });
    try {
      await adapter.removeWorktree(f.project, f.owner, {});
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    } finally { execFileSync("sudo", ["-n", "rm", "-rf", "--", binding.worktreePath], { timeout: 10000 }); }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("rechecks the empty leaf when its parent denies final removal", async () => {
    const f = await fixture(); const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "21" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const parent = path.dirname(binding.worktreePath); await chmod(parent, 0o555);
    try {
      await adapter.removeWorktree(f.project, f.owner, {});
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    } finally { await chmod(parent, 0o755); }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("retries an already empty worktree when its parent denies removal", async () => {
    const f = await fixture(); const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "22" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    for (const name of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, name), { recursive: true, force: true });
    const parent = path.dirname(binding.worktreePath); await chmod(parent, 0o555);
    try {
      await adapter.removeWorktree(f.project, f.owner, {});
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    } finally { await chmod(parent, 0o755); }
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("runs cleanup as root without invoking sudo", async () => {
    const f = await fixture(); const fake = path.join(f.root, "commands"); await mkdir(fake);
    await writeFile(path.join(fake, "sudo"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
    const module = new URL("../../../dist/commands/worker/worktrees.js", import.meta.url).href;
    const operationModule = new URL("../../../dist/api/operation.js", import.meta.url).href;
    const script = `
      import { createWorkerGitManager } from ${JSON.stringify(module)};
      import { createOperation } from ${JSON.stringify(operationModule)};
      import { mkdir, chown, writeFile } from 'node:fs/promises';
      import path from 'node:path';
      const input = JSON.parse(process.argv[1]);
      process.env.PATH = input.fake + ':' + process.env.PATH;
      const op = createOperation();
      const manager = createWorkerGitManager({ temporaryDirectory: path.join(input.root, 'temporary'), prepareFormat: async () => {}, readCleanupPolicy: () => ({ enableSudoCleanup: true, sudoRevision: '18', enableWindowsProcessCleanup: false, windowsProcessRevision: null }) });
      try {
        await manager.prepareRepository(input.project, op);
        const binding = await manager.prepareWorktree(input.project, input.owner, op);
        const foreign = path.join(binding.worktreePath, 'foreign');
        await mkdir(foreign); await writeFile(path.join(foreign, 'file'), 'remove'); await chown(foreign, input.uid, input.gid);
        await manager.removeWorktree(input.project, input.owner, {});
        console.log(binding.worktreePath);
      } finally { op.dispose(); await manager.dispose(); }
    `;
    const uid = process.getuid!(), gid = process.getgid!();
    execFileSync("sudo", ["-n", "chown", "-R", "0", f.root], { timeout: 10000 });
    let result: string;
    try {
      result = execFileSync("sudo", ["-n", process.execPath, "--input-type=module", "-e", script, JSON.stringify({ ...f, fake, uid, gid })], { timeout: 30000, encoding: "utf8" }).trim();
    } finally { execFileSync("sudo", ["-n", "chown", "-R", `${uid}:${gid}`, f.root], { timeout: 10000 }); }
    expect(worktreePaths(f.repository)).not.toContain(path.normalize(result));
  });

  it.skipIf(process.platform === "win32" || !(process.env.CI || process.env.DAYNIGHT_TEST_SUDO))("keeps the task gate through cancellation until the real sudo child exits", async () => {
    const f = await fixture(); const adapter = manager(f.root, { readCleanupPolicy: () => (cleanupPolicy({ enableSudoCleanup: true, sudoRevision: "19" })) });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const owned = path.join(binding.worktreePath, "root-owned");
    const shim = path.join(f.root, "commands"), ready = path.join(f.root, "sudo-ready"), release = path.join(f.root, "sudo-release");
    await mkdir(shim);
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const hold = path.join(shim, "hold-sudo.sh");
    await writeFile(hold, `#!/bin/sh
set -eu
ready=$1
release=$2
shift 2
[ "$(/usr/bin/id -u)" = 0 ]
: > "$ready"
attempts=0
while [ ! -f "$release" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 400 ]; then
    printf '%s\\n' 'Privileged fixture was not released.' >&2
    exit 1
  fi
  sleep 0.025
done
exec "$@"
`);
    await writeFile(path.join(shim, "sudo"), `#!/bin/sh\nshift 4\nexec /usr/bin/sudo -n -u root -- /bin/sh ${shellQuote(hold)} ${shellQuote(ready)} ${shellQuote(release)} "$@"\n`, { mode: 0o755 });
    execFileSync("/usr/bin/sudo", ["-n", "mkdir", owned], { timeout: 10000 });
    const previousPath = process.env.PATH;
    const restorePath = () => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; };
    process.env.PATH = `${shim}:${previousPath ?? ""}`;
    const controller = new AbortController(); let settled = false;
    const attempt = adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(error => error).finally(() => { settled = true; });
    try {
      await vi.waitFor(async () => expect((await lstat(ready)).isFile()).toBe(true), { timeout: 10_000, interval: 10 });
      controller.abort(new Error("cancel test"));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      await expect(adapter.removeWorktree(f.project, f.owner, {})).rejects.toThrow("already in progress");
      expect(settled).toBe(false);
      await writeFile(release, "");
      expect(errorText(await attempt)).toContain("cancel");
      restorePath();
      await adapter.removeWorktree(f.project, f.owner, {});
      expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
    } finally {
      restorePath();
      try { await writeFile(release, ""); }
      finally {
        await attempt;
        execFileSync("/usr/bin/sudo", ["-n", "rm", "-rf", "--", owned], { timeout: 10000 });
      }
    }
  });



  it("uses a fresh observation budget after the effect deadline", async () => {
    const f = await repositoryFixture("files"); let offset = 0;
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (args.includes("worktree") && args.includes("remove")) offset = 301_000;
      return result;
    }) });
    await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const failure = new Error("repository observation failed"); let armed = false; let reads = 0;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (armed) { reads++; if (reads === 1) throw failure; }
      return runRepositoryGit(cwd, args, op, options);
    } });
    await prepareCleanupFixture(f, adapter);
    await adapter.removeWorktree(f.project, f.owner, {});
    armed = true;
    await expect(adapter.removeWorktree(f.project, f.owner, {})).rejects.toBe(failure);
    expect(reads).toBe(1);
  });

  it("preserves both removal and fresh observation errors", async () => {
    const f = await repositoryFixture("files"); const effect = new Error("remove failed"); const observation = new Error("observation failed"); let removed = false;
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
    await prepareCleanupFixture(f, adapter);
    const error = await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ cause: effect, errors: [effect, observation] });
  });

  it("waits for the original Git join before observing absence", async () => {
    const f = await repositoryFixture("files"); const joined = Promise.withResolvers<GitSettlement>(); const reported = Promise.withResolvers<void>();
    const failure = new RepositoryGitCleanupPendingError([], new Error("Git outcome failed after removal")); let readsAfterRemoval = 0; let removed = false;
    const adapter = manager(f.root, {
      runGit: async (cwd, args, op, options) => { if (removed) readsAfterRemoval++; return runRepositoryGit(cwd, args, op, options); },
      startOwnedGit: (cwd, args, op, options) => {
        if (!args.includes("worktree") || !args.includes("remove")) return startOwnedRepositoryGit(cwd, args, op, options);
        const outcome = runRepositoryGit(cwd, args, op, options).then(() => { removed = true; reported.resolve(); return { kind: "cleanup-pending" as const, error: failure }; });
        return { outcome, joined: joined.promise, requestStop: () => {} };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const controller = new AbortController(); let removed = false; let readsAfterRemoval = 0;
    const adapter = manager(f.root, {
      runGit: async (cwd, args, op, options) => { if (removed) readsAfterRemoval++; return runRepositoryGit(cwd, args, op, options); },
      startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
        const result = await runRepositoryGit(cwd, args, op, options);
        if (args.includes("worktree") && args.includes("remove")) { removed = true; controller.abort(new Error("shutdown")); }
        return result;
      }),
    });
    await prepareCleanupFixture(f, adapter);
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(error => error);
    expect(errorText(error)).toContain("shutdown"); expect(readsAfterRemoval).toBe(0);
  });

  it("preserves an effect error and cancellation between budgets without observing again", async () => {
    const f = await repositoryFixture("files"); const controller = new AbortController();
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
    await prepareCleanupFixture(f, adapter);
    const error = await adapter.removeWorktree(f.project, f.owner, { signal: controller.signal }).catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.cause).toBe(effect);
    expect(error.errors[0]).toBe(effect);
    expect(error.errors[1]).toMatchObject({ kind: "cancelled", cause: shutdown });
    expect(readsAfterRemoval).toBe(0);
  });

  it.each([false, true])("preserves cancellation after a successful fresh observation (effect failed: %s)", async (failEffect) => {
    const f = await repositoryFixture("files"); const controller = new AbortController(); const shutdown = new Error("shutdown after observation");
    const effect = new Error("lost removal response");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (failEffect && args.includes("worktree") && args.includes("remove")) throw effect;
      return result;
    }) });
    await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files");
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const adapter = manager(f.root, { removeDirectory: async (target, options) => {
      entered.resolve(); await release.promise; await rm(target, options);
    } });
    const second = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const adapter = manager(f.root);
    const binding = await prepareCleanupFixture(f, adapter);
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

  it.skipIf(process.platform !== "win32")("recovers a pointerless empty worktree after an earlier termination attempt failed", async () => {
    const f = await repositoryFixture("files");
    let stops = 0, allowed = false, terminated = false;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "9" }),
      stopHoldingProcesses: async (target, _operation, options) => {
        stops++;
        // The first attempt fails after the pointer is already unlinked, so
        // every later attempt arrives through the pointerless-empty branch.
        if (!allowed) throw new Error("holder inventory interrupted");
        terminated = true;
        const holder = { pid: 909, image: "node.exe", directory: target };
        options?.onTerminated?.(holder);
        return { observed: [holder], terminated: [909] };
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const root = path.normalize(binding.worktreePath);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      if (!terminated) throw busyError();
      return actualFs.rmdir(target, options);
    });
    const first = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as AggregateError);
    expect(errorText(first)).toContain("EBUSY");
    expect(errorText(first)).toContain("holder inventory interrupted");
    expect(stops).toBe(1);
    // The interrupted attempt left the worktree registered, empty and without
    // its Git pointer; a later attempt must still reach the recovery.
    expect(await readFile(path.join(root, ".git"), "utf8").catch(() => null)).toBeNull();
    expect(worktreePaths(f.repository)).toContain(root);
    allowed = true;
    await adapter.removeWorktree(f.project, f.owner, operation());
    expect(stops).toBe(2);
    expect(worktreePaths(f.repository)).not.toContain(root);
    expect(await lstat(root).catch(() => null)).toBeNull();
  });

  it.skipIf(process.platform !== "win32").each(["manifest", "registration"] as const)("terminates no holder when the pointerless worktree loses its %s during the busy backoff", async kind => {
    const f = await repositoryFixture("files");
    let stops = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "9" }),
      stopHoldingProcesses: async (target, _operation, options) => { stops++; const holder = { pid: 911, image: "node.exe", directory: target }; options?.onTerminated?.(holder); return { observed: [holder], terminated: [911] }; },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const admin = administrativeDirectory(binding.worktreePath);
    const manifestPath = path.join(f.repository, ".git", "daynight", "worktrees", `${f.owner.worktreeId}.json`);
    for (const entry of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, entry), { recursive: true, force: true });
    const root = path.normalize(binding.worktreePath);
    let broken = false;
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      if (!broken) {
        broken = true;
        // The evidence the first attempt proved stops being true before the
        // recovery decides whose processes to terminate.
        if (kind === "manifest") rmSync(manifestPath, { force: true });
        else writeFileSync(path.join(admin, "gitdir"), "C:\\elsewhere\\.git\n");
      }
      throw busyError();
    });
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as Error);
    expect(errorText(error)).toContain(kind === "manifest" ? "manifest changed" : "metadata gitdir changed");
    expect(stops).toBe(0);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("terminates no holder when the registration is retargeted while the evidence is captured", async () => {
    const f = await repositoryFixture("files");
    let stops = 0;
    const adapter = manager(f.root, {
      readCleanupPolicy: () => cleanupPolicy({ enableWindowsProcessCleanup: true, windowsProcessRevision: "9" }),
      stopHoldingProcesses: async (target, _operation, options) => { stops++; const holder = { pid: 913, image: "node.exe", directory: target }; options?.onTerminated?.(holder); return { observed: [holder], terminated: [913] }; },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    const admin = administrativeDirectory(binding.worktreePath);
    for (const entry of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, entry), { recursive: true, force: true });
    const root = path.normalize(binding.worktreePath);
    let retargeted = false;
    const pointer = path.normalize(path.join(root, ".git"));
    vi.mocked(lstat).mockImplementation((async (target: Parameters<typeof actualFs.lstat>[0], options: Parameters<typeof actualFs.lstat>[1]) => {
      // The branch tests the absent pointer directly after the inspection that
      // resolved the registration, and the evidence is captured right after.
      // Retargeting here is the window a baseline taken from disk would miss.
      if (!retargeted && path.normalize(String(target)) === pointer) {
        retargeted = true;
        writeFileSync(path.join(admin, "gitdir"), "C:\\elsewhere\\.git\n");
      }
      return actualFs.lstat(target, options);
    }) as typeof actualFs.lstat);
    vi.mocked(rmdir).mockImplementation(async (target, options) => {
      if (path.normalize(String(target)) !== root) return actualFs.rmdir(target, options);
      throw busyError();
    });
    const error = await adapter.removeWorktree(f.project, f.owner, operation()).catch(failure => failure as Error);
    expect(retargeted).toBe(true);
    expect(errorText(error)).toContain("while its ownership evidence was captured");
    expect(stops).toBe(0);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it("retains a pointerless empty worktree that is locked during the busy backoff", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root); const binding = await prepareCleanupFixture(f, adapter);
    // Captured while the pointer still resolves, then emptied to reach the
    // recovery branch for a registered worktree whose pointer is already gone.
    const admin = administrativeDirectory(binding.worktreePath);
    for (const entry of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, entry), { recursive: true, force: true });
    const root = path.normalize(binding.worktreePath);
    let attempts = 0;
    vi.mocked(rmdir).mockImplementation(async (entry, options) => {
      if (path.normalize(String(entry)) !== root) return actualFs.rmdir(entry, options);
      attempts++;
      // Only the first attempt is busy, and the lock appears during its
      // backoff: a retry that did not revalidate would remove the directory.
      if (attempts > 1) return actualFs.rmdir(entry, options);
      writeFileSync(path.join(admin, "locked"), "human");
      throw busyError();
    });
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, operation()).catch(error => error))).toContain("acquired a Git lock");
    expect(attempts).toBe(1);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });

  it("retains worktree contents that are locked during the busy backoff of an entry removal", async () => {
    const f = await repositoryFixture("files");
    let attempts = 0;
    let admin = "";
    const adapter = manager(f.root, {
      removeDirectory: async (target, options) => {
        if (admin === "") return actualFs.rm(target, options);
        attempts++;
        // Only the first entry removal is busy, and the lock appears during
        // its backoff: a retry admitted on local identity alone would delete
        // the entry and go on clearing the worktree.
        if (attempts > 1) return actualFs.rm(target, options);
        writeFileSync(path.join(admin, "locked"), "human");
        throw busyError();
      },
    });
    const binding = await prepareCleanupFixture(f, adapter);
    admin = administrativeDirectory(binding.worktreePath);
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, operation()).catch(error => error))).toContain("acquired a Git lock");
    expect(attempts).toBe(1);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    expect(worktreePaths(f.repository)).toContain(path.normalize(binding.worktreePath));
  });

  it("retains a pointerless leaf and a replacement instead of recursively deleting either", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root); const binding = await prepareCleanupFixture(f, adapter);
    await rm(path.join(binding.worktreePath, ".git"));
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer is missing"); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    await rename(binding.worktreePath, `${binding.worktreePath}-original`); await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "must survive\n");
    expect(errorText(await adapter.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer is missing"); expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("must survive\n");
  });

  it("retains delete-and-recreate replacements after leaf deletion but before administrative cleanup", async () => {
    const f = await repositoryFixture("files"); const interrupted = new Error("interrupted before administrative removal");
    const adapter = manager(f.root, { startOwnedGit: ownedRunner(async (cwd, args, op, options) => { if (args.includes("worktree") && args.includes("remove")) throw interrupted; return runRepositoryGit(cwd, args, op, options); }) });
    const binding = await prepareCleanupFixture(f, adapter); const admin = administrativeDirectory(binding.worktreePath);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toBe(interrupted); await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "must survive inode reuse\n");
    const second = manager(f.root); expect(errorText(await second.removeWorktree(f.project, f.owner, {}).catch(error => error))).toContain("Git pointer is missing");
    expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("must survive inode reuse\n"); expect(createWorktreeManifestStore(path.join(f.repository, ".git")).read(ids.worktreeId)).toMatchObject(f.owner);
    await rm(binding.worktreePath, { recursive: true }); await second.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("finishes an empty leaf and its registration after the final pointer unlink interruption", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root); const binding = await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const adapter = manager(f.root); const alias = path.join(f.root, "alias"); await symlink(f.repository, alias);
    await expect(adapter.prepareRepository({ ...f.project, localPath: alias }, operation())).rejects.toThrow("ordinary directory");
    const outside = path.join(f.root, "outside"); await mkdir(outside); await symlink(outside, path.join(f.repository, ".worktrees"));
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("ordinary directory"); expect(await readdir(outside)).toEqual([]);
  });

  it("rejects pre-cancelled work before creating any resources", async () => {
    const f = await repositoryFixture("files"); const adapter = manager(f.root); const controller = new AbortController(); controller.abort(new Error("cancelled"));
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
    const f = await repositoryFixture("files"), adapter = manager(f.root), binding = await prepareCleanupFixture(f, adapter);
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
    const f = await repositoryFixture("files"); const adapter = manager(f.root); const binding = await prepareCleanupFixture(f, adapter);
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
      const cancellation = new Error(`cancel ${command}`);
      const grace = captureSynchronousDeadline(() => signal.abort(cancellation));
      try {
        expect(grace.count).toBe(1);
        expect(grace.requested).toBe(1_000);
        grace.markReady();
        await grace.expire();
      } finally { grace.restore(); }
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

  it("unblocks the original mutation and manager disposal when inventory confirms its Git closure", async () => {
    const f = await fixture(), journalDirectory = path.join(f.root, "journal");
    const journal = await openExecutionResourceJournal({ directory: journalDirectory, identity: {
      serverOrigin: "https://daynight.example", userId: ids.taskId, workerId: ids.workerId,
    } });
    const replace = files.replaceFileAtomically;
    let rejectStop = true, fetches = 0;
    const replacement = vi.spyOn(files, "replaceFileAtomically").mockImplementation(async (file, text, ...rest) => {
      if (rejectStop && path.dirname(file) === journalDirectory && JSON.parse(String(text)).event.stage === "stopped") throw new Error("original Git stop save failed");
      return replace(file, text, ...rest);
    });
    const reported = Promise.withResolvers<void>(), settled = vi.fn();
    const adapter = manager(f.root, {
      startOwnedGit: (cwd, args, op, options) => {
        if (!args.includes("fetch")) return startOwnedRepositoryGit(cwd, args, op, options);
        fetches++;
        return withOwnedCommandLifecycle(journal.sink("1"), () => startOwnedRepositoryGit(cwd, args, op, options));
      },
      reportPending: () => reported.resolve(), reportSettled: settled,
    });
    const preparation = adapter.prepareWorktree(f.project, f.owner, operation()).catch(error => error);
    try {
      await Promise.race([reported.promise, preparation.then(error => { throw error; })]);
      await expect(withinExecutionDeadline(preparation, Date.now() + 50)).rejects.toThrow();
      const closing = adapter.dispose();
      rejectStop = false;
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 10_000 });
      expect(await withinExecutionDeadline(preparation, Date.now() + 1000)).toMatchObject({ code: "repository_git_cleanup_pending" });
      await withinExecutionDeadline(closing, Date.now() + 1000);
      expect(settled).toHaveBeenCalledOnce(); expect(fetches).toBe(1);
      expect(await readdir(path.join(f.root, "temporary"))).toEqual([]);
      await journal.assertClosed();
    } finally {
      rejectStop = false;
      await journal.reconcileRetained({ generation: "1", deadline: Date.now() + 10_000 });
      await withinExecutionDeadline(preparation, Date.now() + 1000);
      await withinExecutionDeadline(adapter.dispose(), Date.now() + 1000);
      replacement.mockRestore();
    }
  }, 30_000);

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

  it("rechecks disposal after a timed out original Git handle closes late", async () => {
    const f = await fixture();
    const pendingError = new RepositoryGitCleanupPendingError([], new Error("Original Git command is awaiting close."));
    const settlement = Promise.withResolvers<GitSettlement>(), reported = Promise.withResolvers<void>();
    const requestStop = vi.fn();
    const adapter = manager(f.root, {
      startOwnedGit: (cwd, args, op, options) => args.includes("fetch")
        ? { outcome: Promise.resolve({ kind: "cleanup-pending", error: pendingError }), joined: settlement.promise, requestStop }
        : startOwnedRepositoryGit(cwd, args, op, options),
      reportPending: () => { reported.resolve(); },
    });
    const preparation = adapter.prepareWorktree(f.project, f.owner, operation()).catch(error => error);
    try {
      await reported.promise;
      // All native fixture preparation has joined. Only the controlled original
      // handle remains, so advancing this clock cannot bypass a real process.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const first = adapter.dispose().catch(error => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toMatchObject({ message: expect.stringContaining("original Git responsibilities are retained") });
      expect(requestStop).toHaveBeenCalledOnce();
      expect((await readdir(path.join(f.root, "temporary"))).filter(name => name.startsWith("git-hooks-"))).toHaveLength(1);
      settlement.resolve({ kind: "local-closed", cleanupErrors: [] });
      expect(await preparation).toBe(pendingError);
      await expect(adapter.dispose()).resolves.toBeUndefined();
      expect(await readdir(path.join(f.root, "temporary"))).toEqual([]);
      await expect(adapter.prepareRepository(f.project, operation())).rejects.toThrow("closing");
    } finally {
      vi.useRealTimers();
      settlement.resolve({ kind: "local-closed", cleanupErrors: [] });
      await preparation; await adapter.dispose();
    }
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
