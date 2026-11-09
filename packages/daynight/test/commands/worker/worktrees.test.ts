import path from "node:path";
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { cleanupOperation } from "../../../src/commands/cleanup-operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { runRepositoryGit } from "../../../src/repository/git.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import type { ResourceOwner, WorkerProject } from "../../../src/commands/worker/types.js";

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
  const result = createWorkerGitManager({ temporaryDirectory: path.join(root, "temporary"), ...options }); managers.push(result); return result;
};
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
  git(repository, ["push", bare, `${commit}:refs/heads/${branch}`]);
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
  vi.unstubAllEnvs();
  operations.splice(0).forEach((entry) => entry.dispose());
  await Promise.allSettled([...pendingReservations]);
  await Promise.all(managers.splice(0).map((entry) => entry.dispose()));
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("worker repositories and task worktrees", () => {
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
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toBeNull();
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await writeFile(path.join(binding.worktreePath, "tracked.txt"), "retained dirty work\n");
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("retained dirty work\n");
    await expect(adapter.findWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("ownership marker");
  });

  it("finds cleanup worktrees read-only and rejects an unattributed present path", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId); await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep");
    await expect(adapter.findWorktree(f.project, f.owner, operation())).rejects.toThrow("no matching ownership registration");
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
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep\n");
    const healthyOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999" };
    const healthy = await adapter.prepareWorktree(f.project, healthyOwner, operation());
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: healthyOwner, binding: healthy }]);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("no matching ownership registration");
    expect(await readFile(path.join(target, "unrelated"), "utf8")).toBe("keep\n");
  });

  it("settles absent resources and empty unregistered reservations from their actual state", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await adapter.removeWorktree(f.project, f.owner, operation());
    await mkdir(target, { recursive: true });
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toBeNull();
    expect(await readdir(target)).toEqual([]);
    await adapter.removeWorktree(f.project, f.owner, operation());
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    await adapter.removeWorktree(f.project, f.owner, operation());
  });

  it("cleans an empty reservation by task identity while retaining nonempty and registered resources", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await adapter.removeEmptyReservation(f.project, ids.taskId, operation());
    await mkdir(target, { recursive: true });
    await adapter.removeEmptyReservation(f.project, ids.taskId, operation());
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(target); await writeFile(path.join(target, "foreign"), "keep\n");
    await expect(adapter.removeEmptyReservation(f.project, ids.taskId, operation())).rejects.toThrow("not empty");
    expect(await readFile(path.join(target, "foreign"), "utf8")).toBe("keep\n");
    await rm(target, { recursive: true });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await expect(adapter.removeEmptyReservation(f.project, ids.taskId, operation())).rejects.toThrow("Git worktree registration");
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    await rm(target, { recursive: true });
    await expect(adapter.removeEmptyReservation(f.project, ids.taskId, operation())).rejects.toThrow("Git worktree registration");
    expect(await adapter.findWorktree(f.project, f.owner, operation())).toEqual(binding);
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

  it("ignores a stripped ownership marker while retaining its registered task resource", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await rm(path.join(administrativeDirectory(binding.worktreePath), "locked"));
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });

  describe("ownership marker discovery", () => {
    const prepare = async () => {
      const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
      const healthyOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999" };
      const healthyBinding = await adapter.prepareWorktree(f.project, healthyOwner, operation());
      const admin = administrativeDirectory(binding.worktreePath); const locked = path.join(admin, "locked"); const original = await readFile(locked, "utf8");
      return { f, adapter, binding, healthyOwner, healthyBinding, admin, locked, original };
    };
    let prepared: Awaited<ReturnType<typeof prepare>>;
    beforeEach(async () => { prepared = await prepare(); });

    it("ignores unrecognized markers while still reporting moved recognized registrations", async () => {
      const { f, adapter, binding, healthyOwner, healthyBinding, admin, locked, original } = prepared;
      for (const marker of ["human", "daynight-worker:{", "daynight-worker:{}", `daynight-worker:${JSON.stringify({ ...JSON.parse(original.slice("daynight-worker:".length)), serverOrigin: "https://example.com" })}`]) {
        await writeFile(locked, `${marker}\n`);
        expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: healthyOwner, binding: healthyBinding }]);
        expect(await readFile(locked, "utf8")).toBe(`${marker}\n`);
        await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow();
      }
      await writeFile(locked, original);
      await writeFile(path.join(admin, "gitdir"), path.join(f.root, "foreign", ".git"));
      await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow("fixed task path");
      expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
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

  it("clones a missing repository using the bounded runner and empty template", async () => {
    const f = await fixture(); const destination = path.join(f.root, "clone"); let cloneTimeout = 0;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (!args.includes("clone")) return runRepositoryGit(cwd, args, op, options);
      expect(args.some((value) => value.startsWith("--template="))).toBe(true); cloneTimeout = options?.timeoutMs ?? 0;
      const rewritten = args.map((value) => value === remote ? f.repository : value);
      const result = await runRepositoryGit(cwd, rewritten, op, options);
      git(destination, ["remote", "set-url", "origin", remote]);
      return result;
    } });
    const result = await adapter.prepareRepository({ ...f.project, localPath: destination }, operation());
    expect(result.root).toBe(destination); expect(cloneTimeout).toBe(120_000); expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("refreshes the remote default again after cloning a missing repository", async () => {
    const f = await fixture(); const destination = path.join(f.root, "clone"); let latest = "";
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (!args.includes("clone")) return runRepositoryGit(cwd, args, op, options);
      const result = await runRepositoryGit(cwd, args.map(value => value === remote ? f.bare : value), op, options);
      git(destination, ["remote", "set-url", "origin", remote]);
      git(destination, ["config", `url.${f.bare}.insteadOf`, remote]);
      latest = commitForOrigin(f.repository, f.bare, "main", "advanced after clone");
      return result;
    } });
    const clone = { ...f.project, localPath: destination };
    await adapter.prepareRepository(clone, operation());
    const binding = await adapter.prepareWorktree(clone, f.owner, operation());
    expect(git(binding.worktreePath, ["rev-parse", "HEAD"])).toBe(latest);
    expect(privateBases(destination)).toBe("");
  });

  it("retries empty failed clone reservations and rejects existing nonrepositories, nested paths and mismatched origins", async () => {
    const f = await fixture(); const failed = new Error("controlled clone failure"); let attempts = 0;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { if (args.includes("clone")) { attempts += 1; throw failed; } return runRepositoryGit(cwd, args, op, options); } });
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
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (!args.includes("clone")) return runRepositoryGit(cwd, args, op, options);
      await writeFile(path.join(destination, "retained"), "user data");
      throw failed;
    } });
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toBe(failed);
    expect(await readFile(path.join(destination, "retained"), "utf8")).toBe("user data");
  });

  it("creates fixed task branch/path with native ownership and preserves the reserved directory inode", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(binding.worktreePath).toBe(path.join(f.repository, ".worktrees", "daynight", ids.taskId)); expect(binding.branch).toBe(`daynight/${ids.taskId}`);
    expect(git(binding.worktreePath, ["symbolic-ref", "HEAD"])).toBe(`refs/heads/${binding.branch}`);
    const owner = JSON.parse((await readFile(path.join(administrativeDirectory(binding.worktreePath), "locked"), "utf8")).slice("daynight-worker:".length));
    const entry = await lstat(binding.worktreePath, { bigint: true });
    expect(owner).toMatchObject({ projectId: ids.projectId, taskId: ids.taskId, claimId: ids.claimId, worktreeId: ids.worktreeId, leaf: `${entry.dev}:${entry.ino}` });
    expect(owner).not.toHaveProperty("serverOrigin");
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
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (args.includes("worktree") && args.includes("add")) throw creation;
      if (args.includes("update-ref") && args.includes("-d")) throw cleanup;
      return runRepositoryGit(cwd, args, op, options);
    } });
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

  it("keeps concurrent tasks on their own fetched commits", async () => {
    const f = await fixture();
    const firstHead = git(f.repository, ["rev-parse", "HEAD"]);
    const fetchHead = path.join(f.repository, ".git", "FETCH_HEAD");
    await writeFile(fetchHead, "sentinel\n");
    git(f.repository, ["update-ref", "refs/remotes/origin/main", firstHead]);
    let fetched!: () => void; const firstFetched = new Promise<void>(resolve => { fetched = resolve; });
    let release!: () => void; const firstMayContinue = new Promise<void>(resolve => { release = resolve; });
    let fetches = 0;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      const result = await runRepositoryGit(cwd, args, op, options);
      if (args.includes("fetch") && ++fetches === 1) { fetched(); await firstMayContinue; }
      return result;
    } });
    const otherOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", worktreeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const first = reservation(adapter.prepareWorktree(f.project, f.owner, operation()));
    try {
      await firstFetched;
      const secondHead = commitForOrigin(f.repository, f.bare, "main", "remote advances between fetches");
      const second = await reservation(adapter.prepareWorktree(f.project, otherOwner, operation()));
      release();
      const firstBinding = await first;
      expect(git(firstBinding.worktreePath, ["rev-parse", "HEAD"])).toBe(firstHead);
      expect(git(second.worktreePath, ["rev-parse", "HEAD"])).toBe(secondHead);
      expect(await readFile(fetchHead, "utf8")).toBe("sentinel\n");
      expect(git(f.repository, ["rev-parse", "refs/remotes/origin/main"])).toBe(firstHead);
      expect(privateBases(f.repository)).toBe("");
    } finally { release(); await Promise.allSettled([first]); }
  });

  it("exposes a real fetch timeout without creating a branch or registration", async () => {
    const f = await fixture(); const blocker = path.join(f.root, "block-fetch.cjs");
    await writeFile(blocker, "setInterval(() => {}, 1000);\n");
    git(f.repository, ["config", "remote.origin.uploadpack", `\"${process.execPath}\" \"${blocker}\"`]);
    const adapter = manager(f.root, { runGit: (cwd, args, op, options) => runRepositoryGit(cwd, args, op, args.includes("fetch") ? { ...options, timeoutMs: 1500 } : options) });
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("deadline exceeded");
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
  });

  it("does not create a branch when cancellation interrupts the refresh", async () => {
    const f = await fixture(); const controller = new AbortController(); const cancelled = new Error("refresh cancelled");
    let fetching!: () => void; const started = new Promise<void>(resolve => { fetching = resolve; });
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (args.includes("fetch")) {
        fetching();
        await new Promise<void>(resolve => op.signal.addEventListener("abort", () => resolve(), { once: true }));
        op.check();
      }
      return runRepositoryGit(cwd, args, op, options);
    } });
    const op = createOperation({ signal: controller.signal }); operations.push(op);
    const pending = reservation(adapter.prepareWorktree(f.project, f.owner, op));
    await started; controller.abort(cancelled);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled", cause: cancelled });
    expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/daynight/${ids.taskId}`])).toBe("");
    expect(worktreePaths(f.repository)).toEqual([path.normalize(f.repository)]);
  });

  it("rejects ownership markers with unexpected fields without changing work", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const marker = path.join(administrativeDirectory(binding.worktreePath), "locked");
    const original = JSON.parse((await readFile(marker, "utf8")).slice("daynight-worker:".length));
    await writeFile(marker, `daynight-worker:${JSON.stringify({ unexpected: "value", ...original })}\n`);
    await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow("ownership marker is invalid");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("recovers an add whose successful result was lost without resetting dirty work", async () => {
    const f = await fixture(); const lost = new Error("lost add response"); let added = false;
    const first = manager(f.root, { runGit: async (cwd, args, op, options) => { const result = await runRepositoryGit(cwd, args, op, options); if (args.includes("add") && args.includes("worktree")) { added = true; throw lost; } return result; } });
    await expect(first.prepareWorktree(f.project, f.owner, operation())).rejects.toBe(lost); expect(added).toBe(true);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId); await writeFile(path.join(target, "tracked.txt"), "changed\n"); await writeFile(path.join(target, "untracked"), "kept\n");
    const second = manager(f.root); const binding = await second.prepareWorktree(f.project, f.owner, operation());
    expect(await second.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    expect(await readFile(path.join(target, "tracked.txt"), "utf8")).toBe("changed\n"); expect(await readFile(path.join(target, "untracked"), "utf8")).toBe("kept\n");
  });

  it("never recreates a missing original worktree or repository", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await rm(binding.worktreePath, { recursive: true });
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("cannot be recreated"); await expect(adapter.verifyWorktree(f.project, f.owner, operation())).rejects.toThrow("cannot be recreated");
    await rename(f.repository, path.join(f.root, "old repository"));
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("original repository");
  });

  it("rejects foreign claims, nonempty unmarked reservations and mismatched projects", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await expect(adapter.prepareWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("does not match this claim");
    await expect(adapter.removeWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("does not match this claim");
    await expect(adapter.verifyWorktree({ ...f.project, projectId: "88888888-8888-4888-8888-888888888888" }, f.owner, operation())).rejects.toThrow("does not belong to this project");
    await adapter.removeWorktree(f.project, f.owner, operation()); await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "keep\n");
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("no matching ownership registration");
    expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("keep\n");
  });

  it.each(["original claim", "new claim"] as const)("reuses an empty unregistered reservation for the %s", async (kind) => {
    const f = await fixture(); const adapter = manager(f.root);
    // We construct retained state directly to reserve the test budget for actual reservation recovery.
    const branch = `daynight/${f.owner.taskId}`;
    const previousHead = git(f.repository, ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "retained task branch"]);
    git(f.repository, ["branch", branch, previousHead]);
    const target = path.join(f.repository, ".worktrees", "daynight", f.owner.taskId);
    await mkdir(target, { recursive: true });
    expect(await readdir(target)).toEqual([]);
    expect(worktreePaths(f.repository)).not.toContain(path.normalize(target));
    const owner = kind === "new claim" ? changedClaim(f.owner) : f.owner;
    const binding = await reservation(adapter.prepareWorktree(f.project, owner, operation()));
    expect(binding.worktreePath).toBe(target);
    expect(await reservation(adapter.verifyWorktree(f.project, owner, operation()))).toEqual(binding);
    expect(git(f.repository, ["rev-parse", binding.branch])).toBe(previousHead);
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    if (kind === "new claim") await expect(reservation(adapter.verifyWorktree(f.project, f.owner, operation()))).rejects.toThrow("does not match this claim");
  });

  it("recovers an interrupted reservation before Git created its branch or registration", async () => {
    const f = await fixture(); const failed = new Error("interrupted before Git worktree add");
    const first = manager(f.root, { runGit: async (cwd, args, op, options) => {
      if (args.includes("worktree") && args.includes("add")) throw failed;
      return runRepositoryGit(cwd, args, op, options);
    } });
    await expect(first.prepareWorktree(f.project, f.owner, operation())).rejects.toBe(failed);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    expect(await readdir(target)).toEqual([]);
    expect(await first.listWorktrees(f.project, operation())).toEqual([]);
    const restarted = manager(f.root); const next = changedClaim(f.owner);
    const binding = await restarted.prepareWorktree(f.project, next, operation());
    expect(await restarted.verifyWorktree(f.project, next, operation())).toEqual(binding);
    expect(await readFile(path.join(target, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("removes dirty terminal worktree with the cleanup Git budget while preserving branches and unrelated work", async () => {
    const f = await fixture(); const timeouts: (number | undefined)[] = [];
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { timeouts.push(options?.timeoutMs); return runRepositoryGit(cwd, args, op, options); } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(timeouts).toContain(120_000); expect(timeouts.every(timeout => timeout === 30_000 || timeout === 120_000)).toBe(true);
    timeouts.length = 0;
    await writeFile(path.join(binding.worktreePath, "unpublished"), "terminal temp\n"); await writeFile(path.join(f.repository, "unrelated"), "keep\n");
    await cleanupOperation(op => adapter.removeWorktree(f.project, f.owner, op));
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
    expect(await readFile(path.join(admin, "locked"), "utf8")).toContain(ids.claimId);
    expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toBe(pointer);
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding);
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("retains content and the Git pointer when the ownership marker changes during removal", async () => {
    const f = await fixture(); let marker = "";
    const adapter = manager(f.root, { removeDirectory: async (target, options) => {
      await rm(target, options); await writeFile(marker, "human-owned\n");
    } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    marker = path.join(administrativeDirectory(binding.worktreePath), "locked");
    const pointer = await readFile(path.join(binding.worktreePath, ".git"), "utf8");
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("changed during cleanup");
    expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toBe(pointer);
    expect(await readdir(binding.worktreePath)).toHaveLength(2);
    expect(await readFile(marker, "utf8")).toBe("human-owned\n");
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
    expect(await result).toBe(op.signal.reason);
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
      await expect(adapter.removeWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("does not match this claim");
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
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("Git pointer is missing"); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
    await rename(binding.worktreePath, `${binding.worktreePath}-original`); await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "must survive\n");
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("Git pointer is missing"); expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("must survive\n");
  });

  it("retains delete-and-recreate replacements after leaf deletion but before administrative cleanup", async () => {
    const f = await fixture(); const interrupted = new Error("interrupted before administrative removal");
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { if (args.includes("worktree") && args.includes("remove")) throw interrupted; return runRepositoryGit(cwd, args, op, options); } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation()); const admin = administrativeDirectory(binding.worktreePath);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toBe(interrupted); await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(binding.worktreePath); await writeFile(path.join(binding.worktreePath, "foreign"), "must survive inode reuse\n");
    const second = manager(f.root); await expect(second.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("Git pointer is missing");
    expect(await readFile(path.join(binding.worktreePath, "foreign"), "utf8")).toBe("must survive inode reuse\n"); expect(await readFile(path.join(admin, "locked"), "utf8")).toContain(ids.claimId);
    await rm(binding.worktreePath, { recursive: true }); await second.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("finishes an empty leaf and its registration after the final pointer unlink interruption", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    for (const name of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, name), { recursive: true });
    const restarted = manager(f.root);
    expect(await restarted.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding }]);
    await restarted.removeWorktree(f.project, f.owner, operation());
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("reconciles a lost successful administrative removal and rejects a new claim at the old path", async () => {
    const f = await fixture(); const lost = new Error("lost remove response");
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { const result = await runRepositoryGit(cwd, args, op, options); if (args.includes("worktree") && args.includes("remove")) throw lost; return result; } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation()); await adapter.removeWorktree(f.project, f.owner, operation());
    const second = manager(f.root); await second.removeWorktree(f.project, f.owner, operation());
    const next = changedClaim(f.owner); const fresh = await second.prepareWorktree(f.project, next, operation()); expect(fresh.worktreePath).toBe(binding.worktreePath);
    await expect(second.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("does not match this claim"); expect(await readFile(path.join(fresh.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });

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

  it("retains worktrees with missing markers or changed Git pointers and branch", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const admin = administrativeDirectory(binding.worktreePath); const locked = path.join(admin, "locked"); const original = await readFile(locked, "utf8");
    await rm(locked); await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("no ownership marker"); await writeFile(locked, original);
    // Git creates hidden .git files on Windows, where reopening them with 'w' fails:
    // https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags
    const pointer = path.join(binding.worktreePath, ".git"); const originalPointer = await readFile(pointer, "utf8");
    await rm(pointer); await writeFile(pointer, `gitdir: ${path.join(f.repository, ".git")}\n`); await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("Git pointer has changed"); await rm(pointer); await writeFile(pointer, originalPointer);
    git(binding.worktreePath, ["checkout", "-b", "other-task"]);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("original task branch"); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("finishes a missing leaf's owned registration without globally pruning unrelated worktrees", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const other = path.join(f.root, "unrelated worktree"); git(f.repository, ["worktree", "add", "--detach", "--lock", "--reason", "unrelated", other, "HEAD"]);
    await rm(binding.worktreePath, { recursive: true }); await rm(path.dirname(binding.worktreePath), { recursive: true });
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).toContain(path.normalize(other)); expect(await readFile(path.join(other, "tracked.txt"), "utf8")).toBe("original\n");
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
  });

  it("uses backend-aware reftable HEAD for creation, dirty recovery and missing-leaf cleanup", async () => {
    const f = await fixture("reftable"); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    expect(git(f.repository, ["rev-parse", "--show-ref-format"])).toBe("reftable");
    await writeFile(path.join(binding.worktreePath, "tracked.txt"), "dirty reftable\n");
    expect(await adapter.verifyWorktree(f.project, f.owner, operation())).toEqual(binding); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("dirty reftable\n");
    await rm(binding.worktreePath, { recursive: true }); await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("refuses foreign and detached reftable HEAD without deleting the owned leaf", async () => {
    const f = await fixture("reftable"); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    git(binding.worktreePath, ["checkout", "-b", "foreign-reftable-branch"]);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("original task branch");
    git(binding.worktreePath, ["checkout", "--detach", "HEAD"]);
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("Git command failed"); expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });
});
