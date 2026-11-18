import path from "node:path";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeCommand } from "../../../src/commands/review/adapters/github.js";
import { commit, createGitTestFixtures, proof, rawGit } from "../../helpers/git-fixtures.js";

const fixtures = createGitTestFixtures("git-administration");
const { fixture } = fixtures;
beforeAll(fixtures.initialize);
afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.cleanup();
});
afterAll(fixtures.dispose);

const overwriteExistingFile = (target: string, contents: string): void => {
  const descriptor = openSync(target, "r+");
  try {
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, contents);
  } finally { closeSync(descriptor); }
};

describe("raw captured commit interpretation", () => {
  it("checks out original PR objects while preserving a local replacement and the user's replacement view", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration);
    const replacement = commit(f.upstream, "LOCAL REPLACEMENT\n", f.base);
    rawGit(f.upstream, ["update-ref", "refs/heads/local-replacement", replacement]);
    rawGit(local.root, ["fetch", "--no-tags", f.upstream, "+refs/pull/101/head:refs/private/head", "+refs/heads/local-replacement:refs/private/replacement"]);
    rawGit(local.root, ["replace", f.head, replacement]);
    const replacementRefs = rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"]);
    const config = readFileSync(path.join(local.commonDirectory, "config"), "utf8");
    expect(rawGit(local.root, ["show", `${f.head}:file.txt`])).toBe("LOCAL REPLACEMENT");
    const prepared = await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    expect(readFileSync(path.join(prepared.path, "file.txt"), "utf8")).toBe("PR\n");
    expect(rawGit(local.root, ["show", `${f.head}:file.txt`])).toBe("LOCAL REPLACEMENT");
    expect(rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/replace"])).toBe(replacementRefs);
    expect(readFileSync(path.join(local.commonDirectory, "config"), "utf8")).toBe(config);
    expect(readFileSync(path.join(local.root, "file.txt"), "utf8")).toBe("base\n");
    expect(prepared.gitEnvironment.GIT_NO_REPLACE_OBJECTS).toBe("1");
    const downstream = await executeCommand("git", ["-C", prepared.path, "show", `${f.head}:file.txt`], {
      timeoutMs: 20_000, maxBufferBytes: 1024, environment: prepared.gitEnvironment,
    });
    expect(downstream.error).toBeNull(); expect(downstream.stdout).toBe("PR\n");
  }, 60_000);

  it("computes the original merge base while leaving a default local graft file and user graph view intact", async () => {
    const f = fixture();
    const main = commit(f.upstream, "main advanced\n", f.base); rawGit(f.upstream, ["update-ref", "refs/heads/main", main]); f.update({ baseSha: main });
    const local = await f.manager.ensureRepository(f.configuration);
    rawGit(local.root, ["fetch", "--no-tags", f.upstream, "+refs/pull/101/head:refs/private/head"]);
    const info = path.join(local.commonDirectory, "info"); mkdirSync(info);
    const graft = `${f.head} ${main}\n`; const graftFile = path.join(info, "grafts"); writeFileSync(graftFile, graft);
    expect(rawGit(local.root, ["merge-base", f.head, main])).toBe(main);
    const prepared = await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    expect(prepared.mergeBaseSha).toBe(f.base);
    expect(readFileSync(graftFile, "utf8")).toBe(graft);
    expect(rawGit(local.root, ["merge-base", f.head, main])).toBe(main);
    expect(readFileSync(path.join(local.root, "file.txt"), "utf8")).toBe("main advanced\n");
    const isolatedGraft = prepared.gitEnvironment.GIT_GRAFT_FILE;
    expect(isolatedGraft).toBeTypeOf("string");
    expect(readFileSync(isolatedGraft!, "utf8")).toBe("");
    const downstream = await executeCommand("git", ["-C", prepared.path, "merge-base", f.head, main], {
      timeoutMs: 20_000, maxBufferBytes: 1024, environment: prepared.gitEnvironment,
    });
    expect(downstream.error).toBeNull(); expect(downstream.stdout.trim()).toBe(f.base);
  }, 60_000);
});

describe("linked administrative authority", () => {
  it("rejects pointers to primary or sibling Git administration without changing their HEAD, index, branches or files", async () => {
    for (const redirect of ["primary", "sibling"] as const) {
      const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const first = f.reserve();
      const worktreePath = f.stageOwnedWorktree(local.root, first);
      const sibling = path.join(f.directory, "manual-sibling"); rawGit(local.root, ["worktree", "add", "-b", "manual-sibling", sibling, f.base]);
      const snapshot = (root: string) => {
        const admin = rawGit(root, ["rev-parse", "--absolute-git-dir"]);
        const status = rawGit(root, ["--no-optional-locks", "status", "--porcelain"]);
        return { head: readFileSync(path.join(admin, "HEAD")), index: readFileSync(path.join(admin, "index")),
          refs: rawGit(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]), contents: readFileSync(path.join(root, "file.txt")),
          status, staged: rawGit(root, ["ls-files", "--stage", "-z"]), commit: rawGit(root, ["rev-parse", "HEAD"]) };
      };
      for (const root of [local.root, sibling]) { writeFileSync(path.join(root, "file.txt"), `${root === sibling ? "sibling" : "primary"} staged`); rawGit(root, ["add", "file.txt"]); }
      const primaryBefore = snapshot(local.root); const siblingBefore = snapshot(sibling);
      const ownedAdmin = rawGit(worktreePath, ["rev-parse", "--absolute-git-dir"]);
      const destination = redirect === "primary" ? local.commonDirectory : rawGit(sibling, ["rev-parse", "--absolute-git-dir"]);
      overwriteExistingFile(path.join(worktreePath, ".git"), `gitdir: ${destination.split(path.sep).join("/")}\n`);
      const next = f.nextRevision(first.id, commit(f.upstream, "next PR\n", f.head));
      await expect(f.manager.prepareWorktree(f.store, local, next.id, proof)).rejects.toThrow("own administrative registration");
      expect(snapshot(local.root)).toEqual(primaryBefore); expect(snapshot(sibling)).toEqual(siblingBefore);
      f.update({ state: "closed" }); f.store.supersedeReview(next.id, proof, 30);
      await expect(f.manager.cleanupWorktree(f.store, local, next, proof)).rejects.toThrow("own administrative registration");
      expect(snapshot(local.root)).toEqual(primaryBefore); expect(snapshot(sibling)).toEqual(siblingBefore);
      expect(existsSync(ownedAdmin)).toBe(true); expect(existsSync(worktreePath)).toBe(true);
    }
  }, 60_000);

  it("accepts a valid relative administrative backpointer and explicitly binds force commands to that administration", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const first = f.reserve();
    const worktreePath = f.stageOwnedWorktree(local.root, first);
    const admin = rawGit(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    rawGit(local.root, ["worktree", "repair", "--relative-paths", worktreePath]);
    expect(path.isAbsolute(readFileSync(path.join(admin, "gitdir"), "utf8").trim())).toBe(false);
    expect(path.isAbsolute(readFileSync(path.join(worktreePath, ".git"), "utf8").trim().slice("gitdir: ".length))).toBe(false);
    const next = f.nextRevision(first.id, commit(f.upstream, "new relative PR\n", f.head));
    expect(await f.manager.prepareWorktree(f.store, local, next.id, proof)).toMatchObject({ kind: "prepared" });
    for (const call of f.calls.filter((call) => call.args.includes("checkout") || call.args.includes("clean"))) {
      for (const [flag, target] of [["--git-dir", admin], ["--work-tree", worktreePath]] as const) {
        const argument = call.args[call.args.indexOf(flag) + 1]!;
        expect(path.isAbsolute(argument)).toBe(true);
        const actual = statSync(argument, { bigint: true });
        const expected = statSync(target, { bigint: true });
        expect(actual.isDirectory()).toBe(true);
        expect([actual.dev, actual.ino]).toEqual([expected.dev, expected.ino]);
      }
    }
  }, 60_000);
});
