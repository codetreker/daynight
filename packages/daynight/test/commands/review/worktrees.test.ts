import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGitManager } from "../../../src/commands/review/adapters/worktrees.js";
import { executeCommand } from "../../../src/commands/review/adapters/github.js";
import type { CommandExecutor } from "../../../src/commands/review/adapters/github.js";
import { commit, createGitTestFixtures, proof, rawGit, uuid } from "../../helpers/git-fixtures.js";

const fixtures = createGitTestFixtures("git");
const { fixture } = fixtures;
beforeAll(fixtures.initialize);
afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.cleanup();
});
afterAll(fixtures.dispose);

describe("local Git repositories and review snapshots", () => {
  it("clones missing code, validates identity, and prepares a fixed detached PR worktree", async () => {
    const f = fixture();
    const local = await f.manager.ensureRepository(f.configuration);
    expect(readFileSync(path.join(local.root, "file.txt"), "utf8")).toBe("base\n");
    const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    expect(prepared).toMatchObject({ kind: "prepared", path: path.join(local.root, ".worktrees", "pr-101"), headSha: f.head, baseSha: f.base, mergeBaseSha: f.base });
    if (prepared.kind !== "prepared") throw new Error("Expected prepared worktree.");
    expect(rawGit(prepared.path, ["rev-parse", "HEAD"])).toBe(f.head);
    expect(rawGit(prepared.path, ["rev-parse", "--symbolic-full-name", "HEAD"])).toBe("HEAD");
    expect(rawGit(local.root, ["worktree", "list", "--porcelain"])).toContain(`locked daynight:${uuid(500)}`);
    expect(f.store.getReview(review.id)?.baseSha).toBe(f.base);
    expect(f.store.getPullRequest(review)?.worktreePath).toBe(prepared.path);
    expect(rawGit(local.root, ["rev-parse", "HEAD"])).toBe(f.base);
  }, 60_000);

  it("rejects a different local clone of the same GitHub repository than the durable registration", async () => {
    const f = fixture(); await f.manager.ensureRepository(f.configuration);
    const other = await f.manager.ensureRepository({ ...f.configuration, path: path.join(f.directory, "other-clone") });
    await expect(f.manager.prepareWorktree(f.store, other, f.reserve().id, proof)).rejects.toThrow("durable repository registration");
    expect(existsSync(path.join(other.root, ".worktrees"))).toBe(false);
  }, 60_000);

  it("preserves the existing checkout, branch refs, remote refs, FETCH_HEAD and sibling worktrees", async () => {
    const f = fixture();
    const local = await f.manager.ensureRepository(f.configuration);
    writeFileSync(path.join(local.root, "file.txt"), "user changes\n");
    writeFileSync(path.join(local.root, ".git", "FETCH_HEAD"), "user fetch sentinel\n");
    rawGit(local.root, ["update-ref", "refs/remotes/origin/main", f.base]);
    const sibling = path.join(local.root, ".worktrees", "manual");
    rawGit(local.root, ["worktree", "add", "--detach", sibling, f.base]);
    writeFileSync(path.join(sibling, "manual.txt"), "retained");
    const beforeRefs = rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"]);
    await f.manager.ensureRepository(f.configuration);
    await f.manager.prepareWorktree(f.store, local, f.reserve().id, proof);
    expect(readFileSync(path.join(local.root, "file.txt"), "utf8")).toBe("user changes\n");
    expect(readFileSync(path.join(local.root, ".git", "FETCH_HEAD"), "utf8")).toBe("user fetch sentinel\n");
    expect(rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes", "refs/tags"])).toBe(beforeRefs);
    expect(readFileSync(path.join(sibling, "manual.txt"), "utf8")).toBe("retained");
  }, 60_000);

  it("rejects mismatched origin, a nested upward-discovered root, bare roots and empty collisions", async () => {
    const f = fixture();
    const local = await f.manager.ensureRepository(f.configuration);
    rawGit(local.root, ["config", "remote.origin.url", "git@github.com:other/repo.git"]);
    await expect(f.manager.ensureRepository(f.configuration)).rejects.toThrow("different GitHub repository");
    rawGit(local.root, ["config", "remote.origin.url", f.configuration.remote]);
    const child = path.join(local.root, "child"); mkdirSync(child);
    await expect(f.manager.ensureRepository({ ...f.configuration, path: child })).rejects.toThrow("exact Git worktree root");
    await expect(f.manager.ensureRepository({ ...f.configuration, path: f.upstream })).rejects.toThrow();
    const empty = path.join(f.directory, "empty"); mkdirSync(empty);
    await expect(f.manager.ensureRepository({ ...f.configuration, path: empty })).rejects.toThrow();
    expect(readdirSync(empty)).toEqual([]);
  }, 60_000);

  it("accepts SSH origin identity without requiring SSH transport and preserves HTTPS API ports", async () => {
    const f = fixture();
    const local = await f.manager.ensureRepository(f.configuration);
    rawGit(local.root, ["config", "remote.origin.url", "ssh://git@github.com:2222/owner/repo.git"]);
    await expect(f.manager.ensureRepository({ ...f.configuration, remote: "git@github.com:owner/repo.git" })).resolves.toMatchObject({ repository: f.repository });
    expect(f.calls.filter((call) => call.args.includes("clone")).every((call) => call.args.includes(f.configuration.remote))).toBe(true);
    const ported = { ...f.configuration, host: "github.example:8443", coordinate: "github.example:8443/owner/repo", remote: "https://github.example:8443/owner/repo.git", path: path.join(f.directory, "ported") };
    const mapped: CommandExecutor = async (file, args, options) => file === "gh" ? { stdout: "fixture-secret\n", stderr: "", error: null } : executeCommand(file, ["-c", "protocol.file.allow=always", "-c", `url.${pathToFileURL(f.upstream).href}.insteadOf=${ported.remote}`, ...args], options);
    const manager = createGitManager({ temporaryDirectory: path.join(f.directory, "tmp"), client: { resolveRepository: async () => ({ ...f.repository, host: ported.host }), listPullRequestNumbers: async () => [], listOpenPullRequests: async () => [], getPullRequest: async () => { throw new Error("unused"); }, getPullRequestReviewSnapshot: async () => { throw new Error("Unexpected review snapshot request in worktree fixture."); }, getPullRequestChecks: async () => { throw new Error("unused"); } }, execute: mapped });
    expect((await manager.ensureRepository(ported)).configuration.host).toBe("github.example:8443");
    expect(rawGit(ported.path, ["config", "--local", "--get", "remote.origin.url"])).toBe(ported.remote);
  }, 60_000);

  it("pins retries to the original base and retains their branch and local context", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    f.store.startAttempt(review.id, { processOwner: uuid(700), stdoutLogPath: path.join(f.directory, "out"), stderrLogPath: path.join(f.directory, "err") }, 30);
    f.store.retryReview({ reviewId: review.id, attempt: 1 }, proof, { error: "retry", retryAt: 40 }, 40);
    f.store.reserveReview(review, { reviewId: uuid(900), sessionId: uuid(901), maxAttempts: 3 }, 40);
    rawGit(prepared.path, ["checkout", "-b", "agent-context"]);
    writeFileSync(path.join(prepared.path, "context.txt"), "retain retry context");
    const newBase = commit(f.upstream, "main advanced\n", f.base);
    rawGit(f.upstream, ["update-ref", "refs/heads/main", newBase]); f.update({ baseSha: newBase });
    expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toEqual(prepared);
    expect(readFileSync(path.join(prepared.path, "context.txt"), "utf8")).toBe("retain retry context");
    expect(rawGit(prepared.path, ["branch", "--show-current"])).toBe("agent-context");
    expect(f.calls.filter((call) => call.args.includes("fetch"))).toHaveLength(1);
  }, 60_000);

  it("clears owned dirty files and nested generated clones for a new revision without resetting a shared branch", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const first = f.reserve();
    const worktreePath = f.stageOwnedWorktree(local.root, first);
    rawGit(worktreePath, ["checkout", "-b", "agent-shared"]);
    writeFileSync(path.join(worktreePath, "file.txt"), "dirty"); writeFileSync(path.join(worktreePath, "junk"), "junk");
    const nested = path.join(worktreePath, "generated-clone"); mkdirSync(nested); rawGit(nested, ["init"]);
    const nextHead = commit(f.upstream, "new PR\n", f.head); const next = f.nextRevision(first.id, nextHead);
    const second = await f.manager.prepareWorktree(f.store, local, next.id, proof);
    expect(second).toMatchObject({ kind: "prepared", path: worktreePath, headSha: nextHead });
    expect(rawGit(local.root, ["rev-parse", "refs/heads/agent-shared"])).toBe(f.head);
    expect(existsSync(path.join(worktreePath, "junk"))).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(rawGit(worktreePath, ["rev-parse", "--symbolic-full-name", "HEAD"])).toBe("HEAD");
  }, 60_000);

  it("returns changed for remote head, Draft, closure, and target changes before worktree mutation", async () => {
    for (const changed of [{ headSha: "a".repeat(40) }, { draft: true }, { state: "closed" as const }, { baseRef: "other" }]) {
      const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
      f.setOnGet(() => f.update(changed));
      expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toEqual({ kind: "changed" });
      expect(existsSync(path.join(local.root, ".worktrees", "pr-101"))).toBe(false);
      expect(f.store.getReview(review.id)?.status).toBe("preparing");
    }
  }, 60_000);

  it("detects force-push races between API capture and fetch without preparing the stale head", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const pushed = commit(f.upstream, "force push\n", f.base); rawGit(f.upstream, ["update-ref", "refs/pull/101/head", pushed]);
    expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toEqual({ kind: "changed" });
    expect(f.store.getReview(review.id)?.baseSha).toBeNull();
  }, 60_000);
});

describe("Git failures, history and invocation boundaries", () => {
  it("removes only a completed failed clone's exclusive destination and permits a clean retry", async () => {
    const f = fixture();
    f.setIntercept(async (_file, args) => {
      expect(args).toContain("clone");
      writeFileSync(path.join(f.configuration.path, "partial"), "partial clone");
      return { stdout: "", stderr: "credential-secret", error: Object.assign(new Error("credential-secret"), { code: 128 }) };
    });
    let failure: unknown;
    try { await f.manager.ensureRepository(f.configuration); } catch (error) { failure = error; }
    expect(String(failure)).toContain("failed exclusive destination was removed");
    expect(JSON.stringify(failure)).not.toContain("credential-secret");
    expect(existsSync(f.configuration.path)).toBe(false);
    f.setIntercept(undefined);
    expect((await f.manager.ensureRepository(f.configuration)).root).toBe(realpathSync(f.configuration.path));
  }, 60_000);

  it("retains a partial clone after cancellation or unknown process termination", async () => {
    for (const failure of [Object.assign(new Error("timeout"), { code: 128, killed: true, signal: "SIGTERM" }), Object.assign(new Error("truncated"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" })]) {
      const f = fixture();
      f.setIntercept(async () => {
        writeFileSync(path.join(f.configuration.path, "partial"), "retained for recovery");
        return { stdout: "", stderr: "", error: failure };
      });
      await expect(f.manager.ensureRepository(f.configuration)).rejects.toThrow("process outcome is uncertain");
      expect(readFileSync(path.join(f.configuration.path, "partial"), "utf8")).toBe("retained for recovery");
      f.setIntercept(undefined);
      await expect(f.manager.ensureRepository(f.configuration)).rejects.toThrow();
    }
  }, 60_000);

  it("does not start Git commands for an already aborted operation", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(f.manager.ensureRepository(f.configuration, controller.signal)).rejects.toThrow("cancelled");
    expect(f.calls).toEqual([]);
    expect(existsSync(f.configuration.path)).toBe(false);
  }, 60_000);

  it("clears inherited Git redirection, injected config and traces and disables checkout hooks", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration);
    const hookMarker = path.join(f.directory, "hook-executed");
    mkdirSync(path.join(local.root, ".git", "hooks"));
    writeFileSync(path.join(local.root, ".git", "hooks", "post-checkout"), `#!/bin/sh\nprintf 'hook' > '${hookMarker.replaceAll("\\", "/")}'\n`, { mode: 0o755 });
    const trace = path.join(f.directory, "trace-secret");
    vi.stubEnv("GIT_DIR", f.upstream); vi.stubEnv("GIT_WORK_TREE", f.directory); vi.stubEnv("GIT_TRACE", trace);
    vi.stubEnv("GIT_CONFIG_COUNT", "1"); vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare"); vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
    const review = f.reserve();
    expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toMatchObject({ kind: "prepared" });
    expect(existsSync(hookMarker)).toBe(false); expect(existsSync(trace)).toBe(false);
    expect(rawGit(local.root, ["rev-parse", "HEAD"])).toBe(f.base);
  }, 60_000);

  it("unshallows existing history only through explicit private fetches and finds the real merge base", async () => {
    const f = fixture();
    const main = commit(f.upstream, "advanced main\n", f.base); rawGit(f.upstream, ["update-ref", "refs/heads/main", main]); f.update({ baseSha: main });
    rawGit(f.directory, ["-c", "protocol.file.allow=always", "clone", "--depth=1", pathToFileURL(f.upstream).href, f.configuration.path]);
    rawGit(f.configuration.path, ["config", "remote.origin.url", f.configuration.remote]);
    expect(rawGit(f.configuration.path, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const beforeRefs = rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"]);
    expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toMatchObject({ kind: "prepared", headSha: f.head, baseSha: main, mergeBaseSha: f.base });
    expect(rawGit(local.root, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(rawGit(local.root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"])).toBe(beforeRefs);
  }, 60_000);

  it("reconciles immutable partial pins without switching to a newly advanced base", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    rawGit(local.root, ["fetch", "--no-tags", f.upstream, "+refs/pull/101/head:refs/private/head"]);
    rawGit(local.root, ["update-ref", `refs/daynight/reviews/${review.id}/head`, f.head]);
    rawGit(local.root, ["update-ref", `refs/daynight/reviews/${review.id}/base`, f.base]);
    const nextBase = commit(f.upstream, "new main\n", f.base); rawGit(f.upstream, ["update-ref", "refs/heads/main", nextBase]); f.update({ baseSha: nextBase });
    expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toMatchObject({ kind: "prepared", baseSha: f.base });
    expect(f.calls.filter((call) => call.args.includes("fetch"))).toHaveLength(0);
  }, 60_000);

  it("retains cleanup intent and error after a completed failure, then reconciles a successful retry", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const worktreePath = f.stageOwnedWorktree(local.root, review);
    f.update({ state: "closed" }); f.store.supersedeReview(review.id, proof, 30);
    f.setIntercept(async () => ({ stdout: "", stderr: "", error: Object.assign(new Error("disk failed"), { code: 128 }) }));
    await expect(f.manager.cleanupWorktree(f.store, local, review, proof)).rejects.toThrow();
    expect(f.store.getPullRequest(review)).toMatchObject({ worktreePath, cleanupPending: true });
    expect(f.store.getPullRequest(review)?.cleanupError).toBeTypeOf("string");
    f.setIntercept(undefined);
    expect(await f.manager.cleanupWorktree(f.store, local, review, proof)).toEqual({ kind: "cleaned" });
  }, 60_000);
});
