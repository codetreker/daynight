import path from "node:path";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import type { Operation } from "../../../src/api/operation.js";
import { runRepositoryGit } from "../../../src/repository/git.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import type { ResourceOwner, WorkerProject } from "../../../src/commands/worker/types.js";

const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worker-git-tests");
const directories: string[] = [];
const managers: ReturnType<typeof createWorkerGitManager>[] = [];
const operations: Operation[] = [];
const env = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, env: env(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).replace(/\r?\n$/, "");
const operation = (): Operation => { const result = createOperation(); operations.push(result); return result; };
const manager = (root: string, options: Partial<Parameters<typeof createWorkerGitManager>[0]> = {}) => {
  const result = createWorkerGitManager({ temporaryDirectory: path.join(root, "temporary"), ...options }); managers.push(result); return result;
};
const remote = "https://example.com/organization/repository.git";
const ids = { projectId: "11111111-1111-4111-8111-111111111111", taskId: "22222222-2222-4222-8222-222222222222", claimId: "33333333-3333-4333-8333-333333333333", workerId: "44444444-4444-4444-8444-444444444444", worktreeId: "55555555-5555-4555-8555-555555555555" };
const fixture = async (refFormat: "files" | "reftable" = "files") => {
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "Git 用户 ")); directories.push(root);
  const repository = path.join(root, "repository"); await mkdir(repository);
  git(repository, ["init", "--initial-branch=main", ...(refFormat === "reftable" ? ["--ref-format=reftable"] : [])]);
  git(repository, ["config", "user.name", "Fixture"]); git(repository, ["config", "user.email", "fixture@example.com"]);
  // Checkout bytes remain stable under native core.autocrlf settings; dirty-work assertions stay exact.
  await writeFile(path.join(repository, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(repository, "tracked.txt"), "original\n"); git(repository, ["add", ".gitattributes", "tracked.txt"]); git(repository, ["commit", "-m", "fixture"]);
  git(repository, ["remote", "add", "origin", remote]);
  const project: WorkerProject = { projectId: ids.projectId, repoUrl: remote, localPath: repository };
  const owner: ResourceOwner = { projectId: ids.projectId, taskId: ids.taskId, claimId: ids.claimId, worktreeId: ids.worktreeId };
  return { root, repository, project, owner };
};
const administrativeDirectory = (cwd: string): string => git(cwd, ["rev-parse", "--absolute-git-dir"]);
const worktreePaths = (cwd: string): string[] => git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter((field) => field.startsWith("worktree ")).map((field) => path.normalize(field.slice(9)));
const changedClaim = (owner: ResourceOwner): ResourceOwner => ({ ...owner, claimId: "66666666-6666-4666-8666-666666666666", worktreeId: "77777777-7777-4777-8777-777777777777" });
afterEach(async () => {
  vi.unstubAllEnvs();
  operations.splice(0).forEach((entry) => entry.dispose());
  await Promise.all(managers.splice(0).map((entry) => entry.dispose()));
  await Promise.all(directories.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("worker repositories and task worktrees", () => {
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

  it("discovers claim resources from Git alone, including registrations whose leaf disappeared", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([]);
    const first = await adapter.prepareWorktree(f.project, f.owner, operation());
    const otherOwner = { ...f.owner, taskId: "99999999-9999-4999-8999-999999999999", claimId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", worktreeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const second = await adapter.prepareWorktree(f.project, otherOwner, operation());
    const unrelated = path.join(f.root, "unrelated worktree");
    git(f.repository, ["worktree", "add", "--detach", "--lock", "--reason", "unrelated", unrelated, "HEAD"]);
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding: first }, { owner: otherOwner, binding: second }]);
    await rm(first.worktreePath, { recursive: true });
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: f.owner, binding: first }, { owner: otherOwner, binding: second }]);
    await adapter.removeWorktree(f.project, f.owner, operation());
    expect(await adapter.listWorktrees(f.project, operation())).toEqual([{ owner: otherOwner, binding: second }]);
    expect(await readFile(path.join(unrelated, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("reports an unregistered reserved task directory during discovery", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const target = path.join(f.repository, ".worktrees", "daynight", ids.taskId);
    await mkdir(target, { recursive: true }); await writeFile(path.join(target, "unrelated"), "keep\n");
    await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow("no recognized ownership registration");
    expect(await readFile(path.join(target, "unrelated"), "utf8")).toBe("keep\n");
  });

  it("reports a stripped ownership marker while retaining its registered task resource", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await rm(path.join(administrativeDirectory(binding.worktreePath), "locked"));
    await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow("no recognized ownership registration");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  });

  it("reports malformed ownership and moved registrations during discovery", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    const admin = administrativeDirectory(binding.worktreePath); const locked = path.join(admin, "locked"); const original = await readFile(locked, "utf8");
    await writeFile(locked, "daynight-worker:{}\n");
    await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow("ownership marker is invalid");
    await writeFile(locked, original);
    await writeFile(path.join(admin, "gitdir"), path.join(f.root, "foreign", ".git"));
    await expect(adapter.listWorktrees(f.project, operation())).rejects.toThrow("fixed task path");
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
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

  it("retains clone failures and rejects existing nonrepositories, nested paths and mismatched origins", async () => {
    const f = await fixture(); const failed = new Error("controlled clone failure"); let attempts = 0;
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { if (args.includes("clone")) { attempts += 1; throw failed; } return runRepositoryGit(cwd, args, op, options); } });
    const destination = path.join(f.root, "failed clone");
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toBe(failed);
    expect(await readdir(destination)).toEqual([]);
    await expect(adapter.prepareRepository({ ...f.project, localPath: destination }, operation())).rejects.toThrow(/Git command failed|worktree root/); expect(attempts).toBe(1);
    await mkdir(path.join(f.repository, "nested"));
    await expect(adapter.prepareRepository({ ...f.project, localPath: path.join(f.repository, "nested") }, operation())).rejects.toThrow("worktree root");
    await expect(adapter.prepareRepository({ ...f.project, repoUrl: "https://example.com/other/repository.git" }, operation())).rejects.toThrow("origin does not match");
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

  it("rejects foreign claims, unmarked reservations and mismatched projects", async () => {
    const f = await fixture(); const adapter = manager(f.root);
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await expect(adapter.prepareWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("does not match this claim");
    await expect(adapter.removeWorktree(f.project, changedClaim(f.owner), operation())).rejects.toThrow("does not match this claim");
    await expect(adapter.verifyWorktree({ ...f.project, projectId: "88888888-8888-4888-8888-888888888888" }, f.owner, operation())).rejects.toThrow("does not belong to this project");
    await adapter.removeWorktree(f.project, f.owner, operation()); await mkdir(binding.worktreePath);
    await expect(adapter.prepareWorktree(f.project, f.owner, operation())).rejects.toThrow("no matching ownership registration");
  });

  it("removes dirty terminal worktree while preserving branches and unrelated work", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    await writeFile(path.join(binding.worktreePath, "unpublished"), "terminal temp\n"); await writeFile(path.join(f.repository, "unrelated"), "keep\n");
    await adapter.removeWorktree(f.project, f.owner, operation()); expect(git(f.repository, ["for-each-ref", "--format=%(refname)", `refs/heads/${binding.branch}`])).toBe(`refs/heads/${binding.branch}`);
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

  it("retains an empty ambiguous directory after the final pointer unlink interruption", async () => {
    const f = await fixture(); const adapter = manager(f.root); const binding = await adapter.prepareWorktree(f.project, f.owner, operation());
    for (const name of await readdir(binding.worktreePath)) await rm(path.join(binding.worktreePath, name), { recursive: true });
    await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toThrow("Git pointer is missing"); expect(await readdir(binding.worktreePath)).toEqual([]);
    await rm(binding.worktreePath, { recursive: true }); await adapter.removeWorktree(f.project, f.owner, operation()); expect(worktreePaths(f.repository)).not.toContain(path.normalize(binding.worktreePath));
  });

  it("reconciles a lost successful administrative removal and rejects a new claim at the old path", async () => {
    const f = await fixture(); const lost = new Error("lost remove response");
    const adapter = manager(f.root, { runGit: async (cwd, args, op, options) => { const result = await runRepositoryGit(cwd, args, op, options); if (args.includes("worktree") && args.includes("remove")) throw lost; return result; } });
    const binding = await adapter.prepareWorktree(f.project, f.owner, operation()); await expect(adapter.removeWorktree(f.project, f.owner, operation())).rejects.toBe(lost);
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
