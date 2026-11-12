import path from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createOperation } from "../../../src/api/operation.js";
import { createWorkerGitManager } from "../../../src/commands/worker/worktrees.js";
import { migrateLegacyWorktrees } from "../../../src/commands/worker/worktrees/migration.js";
import { maxOutputBytes } from "../../../src/repository/git-policy.js";

const reader = vi.hoisted(() => ({
  observe: undefined as ((child: ChildProcess, args: readonly string[], cwd: string) => void) | undefined,
}));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((...args: unknown[]) => {
    const child = Reflect.apply(actual.spawn, undefined, args) as ChildProcess;
    if (args[0] === "git" && reader.observe !== undefined) {
      reader.observe(child, args[1] as readonly string[], (args[2] as { cwd: string }).cwd);
    }
    return child;
  }) as typeof actual.spawn;
  return { ...actual, spawn };
});

const roots: string[] = [];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 10_000,
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
}).trim();
const emptySources = { listSchedules: () => [], listWebTasks: () => [], listHerdrLifecycles: () => [], listHerdrBindings: () => [], listHerdrRetired: () => [], listHerdrResources: () => [] };
const fixture = async () => {
  const scratch = path.resolve(import.meta.dirname, "../../../../../.tmp/worktree-inspection");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(path.join(scratch, "读取 中文 ")); roots.push(root);
  const repository = path.join(root, "primary repository"); await mkdir(repository);
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
  const adapter = createWorkerGitManager({ temporaryDirectory: path.join(root, "temp"), prepareFormat: async (_project, repo, operation) => {
    await migrateLegacyWorktrees({ repositoryPath: repo.root, commonDirectory: repo.commonDirectory, operation, sources: emptySources });
  } });
  return { root, repository, project, owner, adapter };
};
const context = (admin: string, leaf: string): string[] => [`--git-dir=${admin}`, `--work-tree=${leaf}`];
afterEach(async () => {
  reader.observe = undefined;
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

it("keeps real linked-worktree metadata bound to relative pointers and the physical Unicode leaf", async () => {
  const f = await fixture(), operation = createOperation();
  try {
    const repository = await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const admin = await realpath(git(binding.worktreePath, "rev-parse", "--absolute-git-dir"));
    // Git strips a literal /.git suffix from the reverse pointer before canonicalizing its path.
    // https://github.com/git-for-windows/git/blob/581291682ad5a238c08c93d1f5bd4518382a3230/worktree.c#L152-L167
    for (const [pointer, contents] of [
      [path.join(binding.worktreePath, ".git"), `gitdir: ${path.relative(binding.worktreePath, admin).split(path.sep).join("/")}\n`],
      [path.join(admin, "gitdir"), `${path.relative(admin, path.join(binding.worktreePath, ".git")).split(path.sep).join("/")}\n`],
    ] as const) {
      const original = await lstat(pointer, { bigint: true });
      // Git hides .git on Windows; opening the existing file avoids CREATE_ALWAYS's hidden-file refusal.
      // https://github.com/nodejs/node/blob/f14cd3aa7bf9ca8df2cc5b8bb14beb0f335b1d93/doc/api/fs.md#L9309-L9314
      const handle = await open(pointer, "r+");
      try {
        expect(await handle.stat({ bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino });
        await handle.truncate(0);
        await handle.writeFile(contents, "utf8");
      } finally { await handle.close(); }
      expect(await lstat(pointer, { bigint: true })).toMatchObject({ dev: original.dev, ino: original.ino, nlink: original.nlink });
      expect(await readFile(pointer, "utf8")).toBe(contents);
    }
    git(f.repository, "config", "extensions.worktreeConfig", "true");
    const redirected = path.join(f.root, "foreign worktree"); await mkdir(redirected);
    await writeFile(path.join(redirected, "keep"), "unrelated\n");
    git(binding.worktreePath, "config", "--worktree", "core.worktree", path.relative(admin, redirected));
    const args = context(admin, binding.worktreePath);
    expect(await realpath(git(f.repository, ...args, "rev-parse", "--path-format=absolute", "--git-common-dir"))).toBe(repository.commonDirectory);
    expect(git(f.repository, ...args, "config", "--get-all", "remote.origin.url")).toBe(f.project.repoUrl);
    expect(await f.adapter.verifyWorktree(f.project, f.owner, operation)).toEqual(binding);
    const registrations = git(f.repository, "worktree", "list", "--porcelain", "-z")
      .split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9));
    expect(await Promise.all(registrations.map(target => realpath(target)))).toContain(await realpath(binding.worktreePath));
    await f.adapter.removeWorktree(f.project, f.owner, operation);
    await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(redirected, "keep"), "utf8")).toBe("unrelated\n");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it.each(["worktree override", "onbranch include", "worktree include"] as const)("preserves installed Git origin semantics for %s", async kind => {
  const f = await fixture(), operation = createOperation();
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const admin = await realpath(git(binding.worktreePath, "rev-parse", "--absolute-git-dir"));
    const foreign = "https://example.com/foreign/project.git";
    if (kind === "worktree override") {
      git(f.repository, "config", "extensions.worktreeConfig", "true");
      git(binding.worktreePath, "config", "--worktree", "remote.origin.url", foreign);
    } else {
      const included = path.join(f.root, "conditional config 中文");
      await writeFile(included, `[remote "origin"]\n\turl = ${foreign}\n`);
      const condition = kind === "onbranch include" ? `onbranch:${binding.branch}` : `worktree:${binding.worktreePath.split(path.sep).join("/")}`;
      git(f.repository, "config", `includeIf.${condition}.path`, included);
    }
    const direct = git(binding.worktreePath, "config", "--get-all", "remote.origin.url");
    expect(git(f.repository, ...context(admin, binding.worktreePath), "config", "--get-all", "remote.origin.url")).toBe(direct);
    const version = /^git version (\d+)\.(\d+)\./.exec(git(f.repository, "version"));
    expect(version).not.toBeNull();
    const supportsWorktreeCondition = Number(version![1]) > 2 || Number(version![1]) === 2 && Number(version![2]) >= 56;
    if (kind !== "worktree include" || supportsWorktreeCondition) {
      expect(direct).toBe(`${f.project.repoUrl}\n${foreign}`);
      await expect(f.adapter.verifyWorktree(f.project, f.owner, operation)).rejects.toThrow(/origin does not match/);
      const scan = await f.adapter.scanWorktrees(f.project, operation);
      expect(scan.validated).toEqual([]);
      expect(scan.quarantined.length + scan.unknown.length).toBeGreaterThan(0);
    } else {
      expect(direct).toBe(f.project.repoUrl);
      expect(await f.adapter.verifyWorktree(f.project, f.owner, operation)).toEqual(binding);
    }
    expect(await readFile(path.join(binding.worktreePath, "tracked.txt"), "utf8")).toBe("original\n");
  } finally { operation.dispose(); await f.adapter.dispose(); }
}, 30_000);

it("allows native leaf rmdir while the real inspection Git reader remains alive outside it", async () => {
  const f = await fixture(), cancellation = new AbortController();
  const operation = createOperation({ signal: cancellation.signal, limits: { totalMs: 20_000, requestMs: 15_000 } });
  let inspection: Promise<unknown> | undefined;
  let heldChild: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let removal: Promise<void> | undefined;
  let primaryFailure: unknown;
  try {
    await f.adapter.prepareRepository(f.project, operation);
    const binding = await f.adapter.prepareWorktree(f.project, f.owner, operation);
    const admin = await realpath(git(binding.worktreePath, "rev-parse", "--absolute-git-dir"));
    const pointer = await readFile(path.join(binding.worktreePath, ".git"), "utf8");
    const reverse = await readFile(path.join(admin, "gitdir"), "utf8");
    git(f.repository, "config", "extensions.worktreeConfig", "true");
    // Real config output fills the native pipe, keeping Git itself alive until we resume its reader.
    const configuration = `[remote "origin"]\n\turl = ${"x".repeat(maxOutputBytes * 3 / 4)}\n`;
    await writeFile(path.join(admin, "config.worktree"), configuration);
    const held = Promise.withResolvers<void>();
    reader.observe = (child, args, cwd) => {
      if (!args.includes(`--work-tree=${binding.worktreePath}`) || args.slice(-3).join(" ") !== "config --get-all remote.origin.url") return;
      reader.observe = undefined;
      heldChild = child;
      closed = new Promise<void>(resolve => { child.once("close", () => { resolve(); }); });
      child.stdout!.once("data", () => {
        child.stdout!.pause();
        removal = (async () => {
          expect(cwd).toBe(f.repository);
          expect(args).toContain(`--git-dir=${admin}`);
          expect(args).not.toContain("-C");
          expect(child.pid).toBeTypeOf("number");
          expect(child.exitCode).toBeNull();
          expect(process.kill(child.pid!, 0)).toBe(true);
          expect(await readFile(path.join(binding.worktreePath, ".git"), "utf8")).toBe(pointer);
          expect(await readFile(path.join(admin, "gitdir"), "utf8")).toBe(reverse);
          await unlink(path.join(binding.worktreePath, "tracked.txt"));
          await unlink(path.join(binding.worktreePath, ".git"));
          await rmdir(binding.worktreePath);
          await expect(lstat(binding.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
          expect(child.exitCode).toBeNull();
          expect(process.kill(child.pid!, 0)).toBe(true);
          expect(await readFile(path.join(admin, "gitdir"), "utf8")).toBe(reverse);
          expect(await readFile(path.join(admin, "config.worktree"), "utf8")).toBe(configuration);
        })();
        void removal.then(held.resolve, held.reject).finally(() => { child.stdout!.resume(); });
      });
    };
    inspection = f.adapter.verifyWorktree(f.project, f.owner, operation).then(
      () => { throw new Error("The additional real origin must fail existing origin validation."); },
      (error: unknown) => error,
    );
    await Promise.race([held.promise, inspection.then(error => { throw error; })]);
    expect(await inspection).toMatchObject({ message: expect.stringContaining("origin does not match") });
    expect(heldChild).toBeDefined();
    await closed;
    expect(heldChild!.exitCode !== null || heldChild!.signalCode !== null).toBe(true);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    reader.observe = undefined;
    heldChild?.stdout?.resume();
    cancellation.abort(new Error("Join the owned inspection reader."));
    const cleanupFailures: unknown[] = [];
    if (inspection !== undefined) await inspection.catch(error => { cleanupFailures.push(error); });
    if (closed !== undefined) await closed.catch(error => { cleanupFailures.push(error); });
    if (removal !== undefined) await removal.catch(error => { if (error !== primaryFailure) cleanupFailures.push(error); });
    operation.dispose();
    await f.adapter.dispose().catch(error => { cleanupFailures.push(error); });
    if (cleanupFailures.length > 0) {
      throw new AggregateError(primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures], "Worktree inspection fixture cleanup failed.", primaryFailure === undefined ? undefined : { cause: primaryFailure });
    }
  }
}, 30_000);
