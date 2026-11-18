import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGitManager } from "../../../src/commands/review/adapters/worktrees.js";
import { executeCommand } from "../../../src/commands/review/adapters/github.js";
import type { CommandExecutor } from "../../../src/commands/review/adapters/github.js";
import { commit, createGitTestFixtures, proof, rawGit } from "../../helpers/git-fixtures.js";
import type { GitSnapshotEntry } from "../../helpers/git-objects.js";

const fixtures = createGitTestFixtures("git-environment");
const { fixture } = fixtures;
beforeAll(fixtures.initialize);
afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.cleanup();
});
afterAll(fixtures.dispose);

describe("initialized owned submodules", () => {
  it("empties initialized tracked submodule files for a new revision while preserving primary files and shared config", async () => {
    const f = fixture();
    const moduleSource = path.join(f.directory, "module.git"); mkdirSync(moduleSource); rawGit(moduleSource, ["init", "--bare", "--initial-branch=main"]);
    const moduleHead = commit(moduleSource, "module contents\n"); rawGit(moduleSource, ["update-ref", "refs/heads/main", moduleHead]);
    const extra: GitSnapshotEntry[] = [
      { path: ".gitmodules", mode: "100644", contents: `[submodule "module"]\n\tpath = module\n\turl = ${pathToFileURL(moduleSource).href}\n` },
      { path: "module", mode: "160000", object: moduleHead },
    ];
    const main = commit(f.upstream, "main module\n", f.base, extra); rawGit(f.upstream, ["update-ref", "refs/heads/main", main]);
    const head = commit(f.upstream, "PR module\n", main, extra); rawGit(f.upstream, ["update-ref", "refs/pull/101/head", head]); f.update({ headSha: head, baseSha: main });
    const local = await f.manager.ensureRepository(f.configuration);
    rawGit(local.root, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    writeFileSync(path.join(local.root, "module", "file.txt"), "primary submodule dirty");
    rawGit(local.root, ["config", "fetch.recurseSubmodules", "true"]);
    const primaryModuleRefs = rawGit(path.join(local.root, "module"), ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const nextModuleHead = commit(moduleSource, "new remote module\n", moduleHead);
    rawGit(moduleSource, ["update-ref", "refs/heads/main", nextModuleHead]);
    const first = f.reserve(); const prepared = await f.manager.prepareWorktree(f.store, local, first.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    expect(rawGit(path.join(local.root, "module"), ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(primaryModuleRefs);
    rawGit(prepared.path, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    rawGit(path.join(prepared.path, "module"), ["checkout", "-b", "module-agent-context"]);
    writeFileSync(path.join(prepared.path, "module", "file.txt"), "dirty module"); writeFileSync(path.join(prepared.path, "module", "artifact"), "discard");
    const moduleAdmin = rawGit(path.join(prepared.path, "module"), ["rev-parse", "--absolute-git-dir"]);
    const refs = rawGit(path.join(prepared.path, "module"), ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const sharedConfig = readFileSync(path.join(local.commonDirectory, "config"), "utf8");
    const nextHead = commit(f.upstream, "next PR module\n", head, extra); const next = f.nextRevision(first.id, nextHead);
    expect(await f.manager.prepareWorktree(f.store, local, next.id, proof)).toMatchObject({ kind: "prepared", headSha: nextHead });
    expect(readdirSync(path.join(prepared.path, "module"))).toEqual([]);
    expect(readFileSync(path.join(local.root, "module", "file.txt"), "utf8")).toBe("primary submodule dirty");
    expect(rawGit(path.join(local.root, "module"), ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(primaryModuleRefs);
    expect(readFileSync(path.join(local.commonDirectory, "config"), "utf8")).toBe(sharedConfig);
    expect(rawGit(f.directory, [`--git-dir=${moduleAdmin}`, "for-each-ref", "--format=%(refname) %(objectname)"])).toBe(refs);
    rawGit(prepared.path, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    expect(readFileSync(path.join(prepared.path, "module", "file.txt"), "utf8")).toBe("module contents\n");
    f.update({ state: "closed" }); f.store.supersedeReview(next.id, proof, 30);
    expect(await f.manager.cleanupWorktree(f.store, local, next, proof)).toEqual({ kind: "cleaned" });
    expect(readFileSync(path.join(local.root, "module", "file.txt"), "utf8")).toBe("primary submodule dirty");
  }, 60_000);
});

describe("Git configuration and revision-transition regressions", () => {
  it("uses origin even when the prepared Git configuration chooses a different default remote name", async () => {
    const f = fixture(["-c", "clone.defaultRemoteName=upstream"]);
    const local = await f.manager.ensureRepository(f.configuration);
    expect(rawGit(local.root, ["remote"])).toBe("origin");
    expect(rawGit(local.root, ["config", "--local", "remote.origin.url"])).toBe(f.configuration.remote);
    expect(await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof)).toMatchObject({ kind: "prepared" });
  }, 60_000);

  it("empties stale untracked contents when the target revision introduces a tracked gitlink", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const first = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, first.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    const modulePath = path.join(prepared.path, "module"); mkdirSync(modulePath);
    writeFileSync(path.join(modulePath, "stale.txt"), "old untracked contents");
    const extra: GitSnapshotEntry[] = [
      { path: ".gitmodules", mode: "100644", contents: `[submodule "module"]\n\tpath = module\n\turl = ${pathToFileURL(f.upstream).href}\n` },
      { path: "module", mode: "160000", object: f.base },
    ];
    const nextHead = commit(f.upstream, "new gitlink\n", f.head, extra); const next = f.nextRevision(first.id, nextHead);
    expect(await f.manager.prepareWorktree(f.store, local, next.id, proof)).toMatchObject({ kind: "prepared", headSha: nextHead });
    expect(readdirSync(modulePath)).toEqual([]);
    expect(rawGit(prepared.path, ["status", "--porcelain"])).toBe("");
  }, 60_000);

  it("preserves prepared TLS trust and global-config locations in actual native command environments", async () => {
    const f = fixture();
    const caFile = path.join(f.directory, "private-ca.pem"); writeFileSync(caFile, "fixture CA");
    const caDirectory = path.join(f.directory, "trusted-certificates"); mkdirSync(caDirectory);
    const globalConfig = path.join(f.directory, "prepared.gitconfig"); writeFileSync(globalConfig, "[http]\n\tversion = HTTP/1.1\n");
    const preparedEnvironment = { GIT_SSL_CAINFO: caFile, GIT_SSL_CAPATH: caDirectory, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" };
    const names = Object.keys(preparedEnvironment);
    const expected = Object.values(preparedEnvironment);
    for (const [name, value] of Object.entries(preparedEnvironment)) vi.stubEnv(name, value);
    const observed: (string | undefined)[][] = [];
    const nativeReadbacks = new Map<string, { authenticated: boolean; values: unknown }>();
    const execute: CommandExecutor = async (file, args, options) => {
      const environment = { ...process.env, ...options.environment };
      // Node passes the lexicographically first spelling of a Windows environment key.
      const windowsKeys = process.platform === "win32" ? Object.keys(environment).sort() : null;
      observed.push(names.map((name) => {
        const key = windowsKeys === null ? name : windowsKeys.find((candidate) => candidate.toUpperCase() === name);
        return key === undefined ? undefined : environment[key];
      }));
      const command = args.find((argument) => argument === "clone" || argument === "rev-parse");
      if (file === "git" && command !== undefined && !nativeReadbacks.has(command)) {
        const native = await executeCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1).map(name => process.env[name])))", ...names], options);
        if (native.error !== null) throw native.error;
        nativeReadbacks.set(command, {
          authenticated: args.includes(`credential.https://${f.configuration.host}.helper=`),
          values: JSON.parse(native.stdout),
        });
      }
      return f.execute(file, args, options);
    };
    const manager = createGitManager({ temporaryDirectory: path.join(f.directory, "tmp"), client: f.client, execute });
    const local = await manager.ensureRepository(f.configuration);
    expect(await manager.prepareWorktree(f.store, local, f.reserve().id, proof)).toMatchObject({ kind: "prepared" });
    expect(observed.length).toBeGreaterThan(0);
    for (const variables of observed) expect(variables).toEqual(expected);
    expect(nativeReadbacks.get("clone")).toEqual({ authenticated: true, values: expected });
    expect(nativeReadbacks.get("rev-parse")).toEqual({ authenticated: false, values: expected });
  }, 60_000);

  it("honors committed fixture byte attributes while normal Git autocrlf conversion is enabled", async () => {
    const f = fixture(["-c", "core.autocrlf=true"]); const local = await f.manager.ensureRepository(f.configuration);
    expect(readFileSync(path.join(local.root, "file.txt"), "utf8")).toBe("base\n");
    const prepared = await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    expect(readFileSync(path.join(prepared.path, "file.txt"), "utf8")).toBe("PR\n");
    expect(rawGit(prepared.path, ["check-attr", "text", "--", "file.txt"])).toBe("file.txt: text: unset");
  }, 60_000);

  it("passes physical clone and inspection paths to Git and safely removes a failed aliased destination", async () => {
    const f = fixture(); const physicalParent = path.join(f.directory, "physical"); mkdirSync(physicalParent);
    const aliasParent = path.join(f.directory, "parent-alias"); symlinkSync(physicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const configuration = { ...f.configuration, path: path.join(aliasParent, "checkout") };
    f.store.registerRepository({ ...f.repository, remote: configuration.remote, localPath: configuration.path });
    const local = await f.manager.ensureRepository(configuration);
    const clone = f.calls.find((call) => call.args.includes("clone"));
    expect(clone?.args.at(-1)).toBe(realpathSync(configuration.path));
    await f.manager.ensureRepository(configuration);
    expect(f.calls.filter((call) => call.args.includes("-C")).every((call) => call.args[call.args.indexOf("-C") + 1] === local.root)).toBe(true);
    const failed = { ...configuration, path: path.join(aliasParent, "failed") };
    f.setIntercept(async (_file, args) => {
      expect(args.at(-1)).toBe(realpathSync(failed.path));
      writeFileSync(path.join(failed.path, "partial"), "partial");
      return { stdout: "", stderr: "", error: Object.assign(new Error("fixture clone failed"), { code: 128 }) };
    });
    await expect(f.manager.ensureRepository(failed)).rejects.toThrow("failed exclusive destination was removed");
    expect(existsSync(failed.path)).toBe(false); expect(existsSync(aliasParent)).toBe(true); expect(existsSync(local.root)).toBe(true);
  }, 60_000);

  it("preserves leading boundary spaces and internal spaces on every native platform", async () => {
    const f = fixture();
    const configuration = { ...f.configuration, path: path.join(f.directory, " checkout boundary", " repo with spaces") };
    f.store.registerRepository({ ...f.repository, remote: configuration.remote, localPath: configuration.path });
    const local = await f.manager.ensureRepository(configuration);
    expect(local.root).toBe(realpathSync(configuration.path));
    const prepared = await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof);
    expect(prepared).toMatchObject({ kind: "prepared", path: path.join(local.root, ".worktrees", "pr-101") });
  }, 60_000);

  it("preserves supported trailing-space paths and rejects protected Windows names without touching existing data", async () => {
    const f = fixture(["-c", "core.protectNTFS=true"]);
    const directory = path.join(f.directory, " checkout boundary ");
    mkdirSync(directory);
    writeFileSync(path.join(directory, "sentinel"), "existing parent contents");
    const configuration = { ...f.configuration, path: path.join(directory, " repo ") };
    f.store.registerRepository({ ...f.repository, remote: configuration.remote, localPath: configuration.path });
    if (process.platform === "win32" && path.basename(realpathSync(directory)).endsWith(" ")) {
      await expect(f.manager.ensureRepository(configuration)).rejects.toThrow("Cannot clone repository into");
      expect(existsSync(configuration.path)).toBe(false);
      expect(readFileSync(path.join(directory, "sentinel"), "utf8")).toBe("existing parent contents");
      expect(readdirSync(directory)).toEqual(["sentinel"]);
      return;
    }
    const local = await f.manager.ensureRepository(configuration);
    expect(local.root).toBe(realpathSync(configuration.path));
    expect(await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof)).toMatchObject({ kind: "prepared", path: path.join(local.root, ".worktrees", "pr-101") });
  }, 60_000);
});
