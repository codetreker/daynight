import path from "node:path";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperation, OperationError } from "../../src/api/operation.js";
import type { Operation } from "../../src/api/operation.js";
import { discoverRepository, discoverWorktreeRoot, RepositoryGitError, runRepositoryGit } from "../../src/repository/git.js";
import { formatError } from "../../src/platform/diagnostics.js";

const nativeTaskkill = vi.hoisted(() => ({ outcomes: [] as ({ returned: true } | { returned: false; error: unknown })[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execute: typeof actual.execFileSync = (...args: unknown[]) => {
    if (typeof args[0] !== "string" || !/[\\/]System32[\\/]taskkill\.exe$/i.test(args[0])) return Reflect.apply(actual.execFileSync, undefined, args);
    try {
      const result = Reflect.apply(actual.execFileSync, undefined, args);
      nativeTaskkill.outcomes.push({ returned: true });
      return result;
    } catch (error) {
      nativeTaskkill.outcomes.push({ returned: false, error });
      throw error;
    }
  };
  return { ...actual, execFileSync: execute };
});

const scratch = path.resolve(import.meta.dirname, "../../../../.tmp/repository-git-tests");
const directories: string[] = [];
const operations: Operation[] = [];
const fixtureEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
const git = (cwd: string, args: string[], input?: string): string => execFileSync("git", args, {
  cwd, env: fixtureEnvironment(), encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"],
  ...(input === undefined ? {} : { input }),
});
const operation = (options: Parameters<typeof createOperation>[0] = {}): Operation => {
  const created = createOperation(options);
  operations.push(created);
  return created;
};
const directory = async (): Promise<string> => {
  await mkdir(scratch, { recursive: true });
  const created = await mkdtemp(path.join(scratch, "Git 中文 "));
  directories.push(created);
  return created;
};
const repository = async (remote = "https://github.com/Org/Repo.git"): Promise<string> => {
  const root = await directory();
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["remote", "add", "origin", remote]);
  return root;
};
const seedCommit = (root: string): void => {
  const tree = git(root, ["hash-object", "-t", "tree", "-w", "--stdin"], "").trim();
  const commit = git(root, ["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nFixture\n`).trim();
  git(root, ["update-ref", "refs/heads/main", commit]);
};

afterEach(async () => {
  for (const op of operations.splice(0)) op.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  nativeTaskkill.outcomes.splice(0);
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("repository Git discovery", () => {
  it("locates roots without origins or project configuration", async () => {
    const root = await repository();
    git(root, ["remote", "remove", "origin"]);
    const nested = path.join(root, "nested path");
    await mkdir(nested);
    expect(await discoverWorktreeRoot(nested, operation())).toBe(root);
    await expect(readFile(path.join(root, ".daynight/project.yml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(discoverRepository(root, operation())).rejects.toThrow("origin fetch address");
  });

  it("finds Chinese and spaced roots from a subdirectory without loading review state", async () => {
    const root = await repository();
    const sub = path.join(root, "子目录 with spaces");
    await mkdir(sub);
    expect(await discoverRepository(sub, operation())).toEqual({ root, remote: "https://github.com/Org/Repo.git", identity: "github.com/Org/Repo" });
  });

  it("uses Git's default fetch URL and insteadOf configuration", async () => {
    const root = await repository("https://rewrite.invalid/Org/Repo.git");
    git(root, ["config", "url.ssh://git@github.com/.insteadOf", "https://rewrite.invalid/"]);
    git(root, ["config", "remote.origin.pushurl", "https://push.invalid/Other.git"]);
    expect(await discoverRepository(root, operation())).toMatchObject({ remote: "ssh://git@github.com/Org/Repo.git", identity: "github.com/Org/Repo" });
  });

  it("preserves command-overlay and user-file Git configuration", async () => {
    const root = await repository("https://rewrite.invalid/Org/Repo.git");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "url.ssh://git@github.com/.insteadOf");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "https://rewrite.invalid/");
    expect((await discoverRepository(root, operation())).identity).toBe("github.com/Org/Repo");
    vi.unstubAllEnvs();
    vi.stubEnv("GIT_CONFIG_PARAMETERS", "'url.ssh://git@git.example/.insteadOf=https://rewrite.invalid/'");
    expect((await discoverRepository(root, operation())).identity).toBe("git.example/Org/Repo");
    vi.unstubAllEnvs();
    const config = path.join(root, "user config");
    await writeFile(config, '[url "ssh://git@git.example/"]\n\tinsteadOf = https://rewrite.invalid/\n');
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    expect((await discoverRepository(root, operation())).identity).toBe("git.example/Org/Repo");
  });

  it("applies per-command environment overrides before repository selector isolation", async () => {
    const root = await repository();
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "fixture.value"); vi.stubEnv("GIT_CONFIG_VALUE_0", "injected");
    expect((await runRepositoryGit(root, ["config", "--get", "fixture.value"], operation())).stdout.trim()).toBe("injected");
    const environment = { GIT_CONFIG_VALUE_0: "per-command" };
    expect((await runRepositoryGit(root, ["config", "--get", "fixture.value"], operation(), { environment })).stdout.trim()).toBe("per-command");
    expect(environment).toEqual({ GIT_CONFIG_VALUE_0: "per-command" });
    expect(process.env.GIT_CONFIG_VALUE_0).toBe("injected");
    const result = await runRepositoryGit(root, ["config", "--get", "fixture.value"], operation(), {
      allowExitOne: true,
      environment: { GIT_CONFIG_COUNT: undefined, GIT_CONFIG_KEY_0: undefined, GIT_CONFIG_VALUE_0: undefined, GIT_DIR: path.join(root, "wrong git directory") },
    });
    expect(result.exitCode).toBe(1); expect(result.stdout).toBe(""); expect(process.env.GIT_CONFIG_COUNT).toBe("1");
    expect((await runRepositoryGit(root, ["config", "--get", "fixture.value"], operation())).stdout.trim()).toBe("injected");
    expect(path.normalize((await runRepositoryGit(root, ["rev-parse", "--show-toplevel"], operation(), { environment: { GIT_WORK_TREE: "wrong" } })).stdout.trim())).toBe(root);
  });

  it("selects per-command Git configuration without changing later default URL rewrites", async () => {
    const root = await repository("https://rewrite.invalid/Org/Repo.git");
    const inherited = path.join(root, "inherited config");
    const overridden = path.join(root, "per-command config");
    await writeFile(inherited, '[url "ssh://git@github.com/"]\n\tinsteadOf = https://rewrite.invalid/\n');
    await writeFile(overridden, '[url "ssh://git@git.example/"]\n\tinsteadOf = https://rewrite.invalid/\n');
    vi.stubEnv("GIT_CONFIG_GLOBAL", inherited);
    expect((await runRepositoryGit(root, ["remote", "get-url", "origin"], operation(), { environment: { GIT_CONFIG_GLOBAL: overridden } })).stdout.trim()).toBe("ssh://git@git.example/Org/Repo.git");
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(inherited);
    expect((await discoverRepository(root, operation())).identity).toBe("github.com/Org/Repo");
  });

  it("sanitizes per-command trace destinations after applying overrides", async () => {
    const root = await repository();
    const trace = path.join(root, "per-command trace");
    await runRepositoryGit(root, ["version"], operation(), { environment: { GIT_TRACE: trace, GIT_TRACE2_EVENT: trace } });
    await expect(readFile(trace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid per-command timeout %s", async (timeoutMs) => {
    await expect(runRepositoryGit(await directory(), ["version"], operation(), { timeoutMs })).rejects.toThrow("Git command timeout");
  });

  it("keeps linked-worktree roots and worktree-specific origin configuration", async () => {
    const root = await repository();
    seedCommit(root);
    const worktree = path.join(await directory(), "linked worktree 中文");
    git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
    git(root, ["config", "extensions.worktreeConfig", "true"]);
    git(root, ["config", "--unset-all", "remote.origin.url"]);
    git(worktree, ["config", "--worktree", "remote.origin.url", "git@git.example:Linked/Repo.git"]);
    expect((await readFile(path.join(worktree, ".git"), "utf8")).startsWith("gitdir:")).toBe(true);
    expect(await discoverWorktreeRoot(worktree, operation())).toBe(worktree);
    expect(await discoverRepository(worktree, operation())).toEqual({ root: worktree, remote: "git@git.example:Linked/Repo.git", identity: "git.example/Linked/Repo" });
  });

  describe("submodule discovery", () => {
    let submodule: string;

    beforeEach(async () => {
      const root = await repository();
      const source = await repository();
      seedCommit(source);
      git(root, ["-c", "protocol.file.allow=always", "submodule", "add", source, "nested module"]);
      submodule = path.join(root, "nested module");
      git(submodule, ["remote", "set-url", "origin", "git@git.example:Submodule/Repo.git"]);
    });

    it("discovers a submodule's own Git root and origin", async () => {
      expect(await discoverWorktreeRoot(submodule, operation())).toBe(submodule);
      expect(await discoverRepository(submodule, operation())).toEqual({ root: submodule, remote: "git@git.example:Submodule/Repo.git", identity: "git.example/Submodule/Repo" });
    });
  });

  it("ignores inherited repository-target selectors while preserving cwd", async () => {
    const root = await repository();
    const unrelated = await repository("https://git.example/Wrong/Repo.git");
    vi.stubEnv("GIT_DIR", path.join(unrelated, ".git"));
    vi.stubEnv("GIT_WORK_TREE", unrelated);
    vi.stubEnv("GIT_COMMON_DIR", path.join(unrelated, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", path.join(unrelated, ".git", "index"));
    expect((await discoverRepository(root, operation())).identity).toBe("github.com/Org/Repo");
  });

  it("disables inherited trace destinations", async () => {
    const root = await repository();
    const trace = path.join(root, "trace output");
    vi.stubEnv("GIT_TRACE", trace);
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    await discoverRepository(root, operation());
    await expect(readFile(trace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only the command's final newline from roots", async () => {
    if (process.platform === "win32") return;
    const parent = await directory();
    const root = path.join(parent, "space and newline \n");
    await mkdir(root);
    git(root, ["init"]);
    git(root, ["remote", "add", "origin", "git@github.com:Org/Repo.git"]);
    expect((await discoverRepository(root, operation())).root).toBe(root);
  });

  it("rejects outside repositories, bare repositories and missing origins with distinct context", async () => {
    await expect(discoverRepository(path.parse(scratch).root, operation())).rejects.toThrow("Cannot locate a Git repository");
    const bare = await directory();
    git(bare, ["init", "--bare"]);
    await expect(discoverRepository(bare, operation())).rejects.toThrow("repository is bare");
    await expect(discoverWorktreeRoot(bare, operation())).rejects.toThrow("repository is bare");
    const root = await repository();
    git(root, ["remote", "remove", "origin"]);
    await expect(discoverRepository(root, operation())).rejects.toThrow("origin fetch address");
  });

  it("offers status-one semantics for check-ignore without hiding other Git failures", async () => {
    const root = await repository();
    const args = ["check-ignore", "--quiet", "--", ".daynight/project.yml"];
    await expect(runRepositoryGit(root, args, operation())).rejects.toMatchObject({ exitCode: 1 });
    expect((await runRepositoryGit(root, args, operation(), { allowExitOne: true })).exitCode).toBe(1);
    await writeFile(path.join(root, ".gitignore"), "/.daynight/\n");
    expect((await runRepositoryGit(root, args, operation(), { allowExitOne: true })).exitCode).toBe(0);
    await expect(runRepositoryGit(root, ["check-ignore", "--invalid-option"], operation(), { allowExitOne: true })).rejects.toBeInstanceOf(RepositoryGitError);
    expect((await runRepositoryGit(root, ["ls-files", "-z", "--", ".daynight"], operation())).stdout).toBe("");
  });

  it("does not launch Git for an already cancelled operation", async () => {
    const controller = new AbortController();
    const op = operation({ signal: controller.signal });
    controller.abort(new Error("Caller stopped"));
    await expect(runRepositoryGit(await directory(), ["version"], op)).rejects.toBe(op.signal.reason);
  });

  it("bounds captured output before returning repository data", async () => {
    const root = await repository();
    const config = path.join(root, "large config");
    await writeFile(config, `[fixture]\nlarge = ${"x".repeat(1_048_577)}\n`);
    const error: unknown = await runRepositoryGit(root, ["config", "--file", config, "--get", "fixture.large"], operation()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(formatError(error)).toContain("stdout exceeded its 1048576-byte limit");
    if (error instanceof AggregateError) {
      expect(error.message).toContain("process termination is unconfirmed");
      expect(error.errors.length).toBeGreaterThan(0);
      expect(error.cause).toBeInstanceOf(RepositoryGitError);
    }
  });

  it("retains an output-limit refusal when process-group cleanup also fails", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const config = path.join(root, "large config");
    await writeFile(config, `[fixture]\nlarge = ${"x".repeat(1_048_577)}\n`);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) throw Object.assign(new Error("Fixture group termination denied"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    const error: unknown = await runRepositoryGit(root, ["config", "--file", config, "--get", "fixture.large"], operation()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).cause).toBeInstanceOf(RepositoryGitError);
    expect((error as AggregateError).errors).toContainEqual(expect.objectContaining({ code: "EPERM" }));
    expect(formatError(error)).toContain("stdout exceeded its 1048576-byte limit");
    expect(formatError(error)).toContain("process termination is unconfirmed");
  });

  it("retains the output-limit error when the owned process group has already disappeared", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const config = path.join(root, "large config");
    await writeFile(config, `[fixture]\nlarge = ${"x".repeat(1_048_577)}\n`);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => originalKill(pid < 0 ? -2147483647 : pid, signal));
    const error: unknown = await runRepositoryGit(root, ["config", "--file", config, "--get", "fixture.large"], operation()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RepositoryGitError);
    expect(formatError(error)).toContain("stdout exceeded its 1048576-byte limit");
  });

  it("disables the repository's executable fsmonitor for read-only index queries", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const tracked = path.join(root, "tracked.txt");
    await writeFile(tracked, "fixture");
    git(root, ["add", "tracked.txt"]);
    const monitor = path.join(root, "slow fsmonitor");
    const marker = path.join(root, "fsmonitor invoked");
    await writeFile(monitor, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'invoked');\nsetTimeout(() => {}, 2000);\n`);
    await chmod(monitor, 0o755);
    git(root, ["config", "core.fsmonitor", JSON.stringify(monitor)]);
    git(root, ["ls-files", "-z"]);
    expect(await readFile(marker, "utf8")).toBe("invoked");
    await rm(marker);
    expect((await runRepositoryGit(root, ["ls-files", "-z"], operation({ limits: { totalMs: 500 } }))).stdout).toBe("tracked.txt\0");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills an owned descendant even when its exited wrapper leaves output handles open", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const ticks = path.join(root, "descendant ticks");
    const descendant = path.join(root, "descendant.mjs");
    await writeFile(descendant, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(ticks)}, 'started\\n');\nsetInterval(() => appendFileSync(${JSON.stringify(ticks)}, 'tick\\n'), 10);\n`);
    const wrapper = path.join(bin, "git");
    await writeFile(wrapper, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nspawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'inherit'] });\nprocess.exit(0);\n`);
    await chmod(wrapper, 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    const op = operation({ limits: { totalMs: 2000 } });
    const started = performance.now();
    const error: unknown = await runRepositoryGit(root, ["version"], op).catch((failure: unknown) => failure);
    expect(error).toBe(op.signal.reason);
    expect(error).toMatchObject({ kind: "deadline" });
    expect(performance.now() - started).toBeLessThan(3000);
    const stopped = await readFile(ticks, "utf8");
    expect(stopped).toContain("started");
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(await readFile(ticks, "utf8")).toBe(stopped);
  });

  it("redacts repository URL credentials in bounded Git diagnostics", async () => {
    const root = await repository();
    const error: unknown = await runRepositoryGit(root, ["remote", "get-url", "https://private:secret@git.example/Repo.git"], operation()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RepositoryGitError);
    expect(String(error)).toContain("[redacted URL]");
    expect(String(error)).not.toContain("secret");
    expect(String(error)).not.toContain("private");
  });

  it("retains spawn errors without a shell fallback", async () => {
    const root = await repository();
    vi.stubEnv("PATH", "");
    await expect(runRepositoryGit(root, ["version"], operation())).rejects.toMatchObject({
      name: "RepositoryGitError", cause: { code: "ENOENT" },
    });
  });

  it.each(["cancellation", "per-command deadline"] as const)("terminates a real Git alias and its owned Node descendant after %s on every platform", async (stopReason) => {
    const root = await repository();
    const marker = path.join(root, "alias started.json");
    const ticks = path.join(root, "alias ticks");
    const block = path.join(root, "owned-block.mjs");
    await writeFile(block, `import { appendFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));\nsetInterval(() => appendFileSync(${JSON.stringify(ticks)}, 'tick\\n'), 10);\n`);
    git(root, ["config", "alias.daynight-block", `!${JSON.stringify(process.execPath.replaceAll("\\", "/"))} ${JSON.stringify(block.replaceAll("\\", "/"))}`]);
    const controller = new AbortController();
    const op = operation({ signal: controller.signal, limits: { totalMs: 8000 } });
    const pending = runRepositoryGit(root, ["daynight-block"], op, stopReason === "per-command deadline" ? { timeoutMs: 1500 } : {}).catch((error: unknown) => error);
    let ownedPid: number | undefined;
    try {
      const markerDeadline = performance.now() + 4000;
      while (ownedPid === undefined && performance.now() < markerDeadline) {
        try {
          const text = await readFile(marker, "utf8");
          if (text !== "") ownedPid = (JSON.parse(text) as { pid: number }).pid;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (ownedPid === undefined) await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      }
      expect(ownedPid).toBeTypeOf("number");
      const cancelled = performance.now();
      if (stopReason === "cancellation") controller.abort(new Error("Cancel the owned Git alias"));
      const error: unknown = await pending;
      const assertPrimary = (failure: unknown): void => {
        if (stopReason === "cancellation") expect(failure).toBe(op.signal.reason);
        else {
          expect(failure).toBeInstanceOf(RepositoryGitError);
          expect((failure as Error).message).toContain("Repository Git command deadline exceeded");
          expect(op.signal.aborted).toBe(false);
          expect(() => op.check()).not.toThrow();
        }
      };
      if (process.platform === "win32") {
        expect(nativeTaskkill.outcomes).toHaveLength(1);
        const outcome = nativeTaskkill.outcomes[0]!;
        if (outcome.returned) assertPrimary(error);
        else {
          expect(outcome.error).toBeInstanceOf(Error);
          const nativeError = outcome.error as Error & { status?: number; signal?: NodeJS.Signals | null; code?: string };
          expect(nativeError.status).toBeTypeOf("number");
          expect(Number.isFinite(nativeError.status)).toBe(true);
          expect(nativeError.status).not.toBe(0);
          expect(nativeError.signal).toBeNull();
          expect(nativeError.code).toBeUndefined();
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([nativeError]);
          expect((error as AggregateError).errors[0]).toBe(nativeError);
          assertPrimary((error as AggregateError).cause);
        }
      } else assertPrimary(error);
      expect(performance.now() - cancelled).toBeLessThan(2500);
      const stopped = await readFile(ticks, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
      });
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      expect(await readFile(ticks, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
        throw error;
      })).toBe(stopped);
      if (process.platform === "win32") expect(() => process.kill(ownedPid!, 0)).toThrow();
    } finally {
      controller.abort(new Error("Clean up the owned Git alias"));
      await pending;
      if (ownedPid !== undefined) {
        try { process.kill(ownedPid, "SIGKILL"); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
    }
  }, 10_000);

  it.each(["own", "inherit"] as const)("retains the original operation failure after a real blocked Git child closes in its %s group", async (processGroup) => {
    if (process.platform === "win32") return;
    const root = await repository();
    const fifo = path.join(root, "blocked config");
    execFileSync("mkfifo", [fifo], { timeout: 10_000 });
    vi.stubEnv("GIT_CONFIG_SYSTEM", fifo);
    const controller = new AbortController();
    const op = operation({ signal: controller.signal });
    const pending = runRepositoryGit(root, ["config", "--get", "remote.origin.url"], op).catch((error: unknown) => error);
    setTimeout(() => { controller.abort(new Error("Caller stopped")); }, 20);
    expect(await pending).toBe(op.signal.reason);
    expect(op.signal.reason).toBeInstanceOf(OperationError);
  });

  it.each(["own", "inherit"] as const)("stops a blocked child in its %s group when the shared operation deadline expires", async (processGroup) => {
    if (process.platform === "win32") return;
    const root = await repository();
    const fifo = path.join(root, "blocked config");
    execFileSync("mkfifo", [fifo], { timeout: 10_000 });
    vi.stubEnv("GIT_CONFIG_SYSTEM", fifo);
    const op = operation({ limits: { totalMs: 30 } });
    const error: unknown = await runRepositoryGit(root, ["config", "--get", "remote.origin.url"], op, { processGroup }).catch((failure: unknown) => failure);
    expect(error).toBe(op.signal.reason);
    expect(error).toMatchObject({ kind: "deadline" });
  });

  it("retains cleanup failures when wrapping aborted repository discovery", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const fifo = path.join(root, "blocked config");
    execFileSync("mkfifo", [fifo], { timeout: 10_000 });
    vi.stubEnv("GIT_CONFIG_SYSTEM", fifo);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0) throw Object.assign(new Error("Fixture group termination denied"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    const controller = new AbortController();
    const op = operation({ signal: controller.signal });
    const pending = discoverRepository(root, op).catch((error: unknown) => error);
    setTimeout(() => { controller.abort(new Error("Caller stopped")); }, 20);
    const error: unknown = await pending;
    expect(error).toMatchObject({ message: "Cannot locate a Git repository from the current working directory." });
    const cleanup = (error as Error).cause;
    expect(cleanup).toBeInstanceOf(AggregateError);
    expect((cleanup as AggregateError).cause).toBe(op.signal.reason);
    expect((cleanup as AggregateError).errors).toContainEqual(expect.objectContaining({ code: "EPERM" }));
  });
});
