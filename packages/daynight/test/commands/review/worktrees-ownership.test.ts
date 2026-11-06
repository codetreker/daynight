import path from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GitCommandError } from "../../../src/commands/review/adapters/worktrees.js";
import { executeCommand } from "../../../src/commands/review/adapters/github.js";
import { commit, createGitTestFixtures, proof, rawGit, uuid } from "../../helpers/git-fixtures.js";

const fixtures = createGitTestFixtures("git-ownership");
const { fixture } = fixtures;
beforeAll(fixtures.initialize);
afterEach(() => {
  vi.unstubAllEnvs();
  fixtures.cleanup();
});
afterAll(fixtures.dispose);

describe("owned worktree lifecycle and destructive-operation guards", () => {
  it("preserves every unregistered existing path, including an empty directory", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const target = path.join(local.root, ".worktrees", "pr-101"); mkdirSync(target, { recursive: true });
    await expect(f.manager.prepareWorktree(f.store, local, review.id, proof)).rejects.toThrow("Unowned");
    expect(readdirSync(target)).toEqual([]);
    expect(f.store.getPullRequest(review)?.worktreePath).toBeNull();
    rmSync(target, { recursive: true });
    rawGit(local.root, ["worktree", "add", "--detach", target, f.base]);
    await expect(f.manager.prepareWorktree(f.store, local, review.id, proof)).rejects.toThrow("Unowned");
    expect(rawGit(target, ["rev-parse", "HEAD"])).toBe(f.base);
  }, 60_000);

  it("rejects a missing ownership marker and a lost .git pointer before force checkout or deletion", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const first = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, first.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    const next = f.nextRevision(first.id, commit(f.upstream, "new\n", f.head));
    rawGit(local.root, ["worktree", "unlock", prepared.path]);
    await expect(f.manager.prepareWorktree(f.store, local, next.id, proof)).rejects.toThrow("ownership lock");
    rawGit(local.root, ["worktree", "lock", "--reason", `daynight:${uuid(500)}`, prepared.path]);
    rmSync(path.join(prepared.path, ".git"));
    writeFileSync(path.join(prepared.path, "sentinel"), "preserved");
    await expect(f.manager.prepareWorktree(f.store, local, next.id, proof)).rejects.toThrow("managed Git pointer");
    expect(readFileSync(path.join(prepared.path, "sentinel"), "utf8")).toBe("preserved");
    expect(rawGit(local.root, ["rev-parse", "HEAD"])).toBe(f.base);
  }, 60_000);

  it("reconciles an absent leaf with its matching durable ownership lock, without pruning siblings", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    const sibling = path.join(local.root, ".worktrees", "manual-missing"); rawGit(local.root, ["worktree", "add", "--detach", sibling, f.base]); rmSync(sibling, { recursive: true });
    rmSync(prepared.path, { recursive: true });
    expect(await f.manager.prepareWorktree(f.store, local, review.id, proof)).toEqual(prepared);
    expect(rawGit(local.root, ["worktree", "list", "--porcelain"])).toContain(sibling.replaceAll("\\", "/"));
  }, 60_000);

  it("requires process exclusion and the current preparing reservation before any force operation", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    await expect(f.manager.prepareWorktree(f.store, local, review.id, { processesExcluded: false } as unknown as typeof proof)).rejects.toThrow("excluded");
    f.store.markInterrupted(review.id, "unknown previous process", 30);
    await expect(f.manager.prepareWorktree(f.store, local, review.id, proof)).rejects.toThrow("preparing review");
    expect(existsSync(path.join(local.root, ".worktrees", "pr-101"))).toBe(false);
  }, 60_000);

  it("cleans only closed owned worktrees and keeps review refs, session history and siblings", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    const sibling = path.join(local.root, ".worktrees", "manual"); rawGit(local.root, ["worktree", "add", "--detach", sibling, f.base]);
    f.update({ state: "merged" });
    await expect(f.manager.cleanupWorktree(f.store, local, review, proof)).rejects.toThrow("active review");
    f.store.supersedeReview(review.id, proof, 30);
    expect(await f.manager.cleanupWorktree(f.store, local, review, proof)).toEqual({ kind: "cleaned" });
    expect(existsSync(prepared.path)).toBe(false); expect(existsSync(sibling)).toBe(true);
    expect(f.store.getPullRequest(review)).toMatchObject({ worktreePath: null, cleanupPending: false, sessionId: uuid(500) });
    expect(rawGit(local.root, ["rev-parse", `refs/daynight/reviews/${review.id}/head`])).toBe(f.head);
    expect(f.store.listReviews(review)).toHaveLength(1);
    f.update({ state: "open" }); const reopened = f.reserve();
    expect(await f.manager.prepareWorktree(f.store, local, reopened.id, proof)).toMatchObject({ kind: "prepared", path: prepared.path });
    expect(f.store.getPullRequest(review)?.sessionId).toBe(uuid(500));
  }, 60_000);

  it("preserves a remotely reopened PR and retries cleanup after Git already removed its leaf", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    f.update({ state: "closed" }); f.store.supersedeReview(review.id, proof, 30);
    f.setOnGet(() => f.update({ state: "open" }));
    expect(await f.manager.cleanupWorktree(f.store, local, review, proof)).toEqual({ kind: "reopened" });
    expect(existsSync(prepared.path)).toBe(true);
    expect(f.store.getPullRequest(review)).toMatchObject({ cleanupPending: false, cleanupError: null, worktreePath: prepared.path, sessionId: uuid(500) });
    f.setOnGet(undefined); f.update({ state: "closed" });
    rawGit(local.root, ["worktree", "remove", "--force", "--force", prepared.path]);
    expect(await f.manager.cleanupWorktree(f.store, local, review, proof)).toEqual({ kind: "cleaned" });
    expect(f.store.getPullRequest(review)?.worktreePath).toBeNull();
  }, 60_000);

  it("cancels reopened cleanup after inspection without starting worktree removal", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    f.update({ state: "closed" }); f.store.supersedeReview(review.id, proof, 30);
    f.calls.length = 0;
    f.setIntercept(async (file, args, options) => {
      if (args.includes("worktree") && args.includes("list")) {
        f.update({ state: "open" });
        expect(f.store.getPullRequest(review)?.cleanupPending).toBe(true);
      }
      return executeCommand(file, args, options);
    });
    expect(await f.manager.cleanupWorktree(f.store, local, review, proof)).toEqual({ kind: "reopened" });
    expect(f.calls.some(({ args }) => args.includes("worktree") && args.includes("remove"))).toBe(false);
    expect(existsSync(prepared.path)).toBe(true);
    expect(f.store.getPullRequest(review)).toMatchObject({ cleanupPending: false, worktreePath: prepared.path });
    expect(f.reserve().revision).toBe(2);
  }, 60_000);

  it.each(["completed", "uncertain"])("retains reopened cleanup while removal is pending and reconciles its %s result", async (outcome) => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    f.update({ state: "closed" }); f.store.supersedeReview(review.id, proof, 30);
    let started!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    f.setIntercept(async (file, args, options) => {
      if (args.includes("worktree") && args.includes("remove")) {
        started();
        await pending;
        if (outcome === "uncertain") return { stdout: "", stderr: "removal interrupted", error: Object.assign(new Error("removal interrupted"), { code: 128, killed: true, signal: "SIGTERM" }) };
      }
      return executeCommand(file, args, options);
    });
    const cleanup = f.manager.cleanupWorktree(f.store, local, review, proof);
    await entered;
    f.update({ state: "open" });
    expect(f.store.getPullRequest(review)).toMatchObject({ cleanupPending: true, worktreePath: prepared.path, state: "open" });
    expect(f.store.listCleanupCandidates()).toHaveLength(1);
    expect(f.store.listCandidates(31)).toEqual([]);
    finish();
    if (outcome === "uncertain") {
      await expect(cleanup).rejects.toMatchObject({ completed: false });
      expect(f.store.getPullRequest(review)).toMatchObject({ cleanupPending: true, cleanupError: expect.stringContaining("Git operation failed"), worktreePath: prepared.path });
      expect(f.store.listCandidates(32)).toEqual([]);
      expect(existsSync(prepared.path)).toBe(true);
      f.setIntercept(undefined);
      expect(await f.manager.cleanupWorktree(f.store, local, review, proof)).toEqual({ kind: "reopened" });
    } else {
      expect(await cleanup).toEqual({ kind: "reopened" });
      expect(existsSync(prepared.path)).toBe(false);
    }
    expect(f.store.getPullRequest(review)).toMatchObject({ cleanupPending: false, cleanupError: null, worktreePath: prepared.path, sessionId: uuid(500) });
    f.setIntercept(undefined);
    const next = f.reserve();
    expect(await f.manager.prepareWorktree(f.store, local, next.id, proof)).toMatchObject({ kind: "prepared", path: prepared.path });
    expect(existsSync(prepared.path)).toBe(true);
  }, 60_000);

  it("preserves physical root aliases while rejecting symlinked managed containers and leaves", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration);
    const alias = path.join(f.directory, "root-alias");
    symlinkSync(local.root, alias, process.platform === "win32" ? "junction" : "dir");
    expect((await f.manager.ensureRepository({ ...f.configuration, path: alias })).root).toBe(realpathSync(local.root));
    const outside = path.join(f.directory, "outside"); mkdirSync(outside);
    const container = path.join(local.root, ".worktrees"); symlinkSync(outside, container, process.platform === "win32" ? "junction" : "dir");
    const review = f.reserve();
    await expect(f.manager.prepareWorktree(f.store, local, review.id, proof)).rejects.toThrow("ordinary directory");
    expect(readdirSync(outside)).toEqual([]);
    rmSync(container); mkdirSync(container);
    symlinkSync(outside, path.join(container, "pr-101"), process.platform === "win32" ? "junction" : "dir");
    await expect(f.manager.prepareWorktree(f.store, local, review.id, proof)).rejects.toThrow("ordinary directory");
    expect(readdirSync(outside)).toEqual([]);
  }, 60_000);
});

describe("cleanup diagnostics", () => {
  it("preserves the original Git failure when recording its cleanup error also fails", async () => {
    const f = fixture();
    const local = await f.manager.ensureRepository(f.configuration);
    const review = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, review.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected a prepared worktree.");
    f.update({ state: "closed" });
    f.store.supersedeReview(review.id, proof, 21);
    const diagnostic = f.database;
    diagnostic.exec(`CREATE TRIGGER fail_cleanup_diagnostic BEFORE UPDATE OF cleanup_error ON pull_requests
      WHEN NEW.cleanup_error IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture diagnostic write failed'); END;`);
    const removalError = Object.assign(new Error("fixture removal failed"), { code: 1 });
    f.setIntercept(async (file, args, options) => args.includes("remove")
      ? { stdout: "", stderr: "fixture removal failed", error: removalError }
      : executeCommand(file, args, options));
    let failure: unknown;
    try { await f.manager.cleanupWorktree(f.store, local, review, proof); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors[0]).toBeInstanceOf(GitCommandError);
    expect(errors[0]!.cause).toBe(removalError);
    expect(errors[1]!.message).toContain("fixture diagnostic write failed");
    expect((failure as AggregateError).cause).toBe(errors[0]);
    expect(f.store.getPullRequest(review)).toMatchObject({ cleanupPending: true, worktreePath: prepared.path });
    expect(existsSync(prepared.path)).toBe(true);
  });
});

describe("dedicated review environment artifacts", () => {
  it("discards nested ordinary and bare clone artifacts on refresh and closed-PR cleanup", async () => {
    const f = fixture(); const local = await f.manager.ensureRepository(f.configuration); const first = f.reserve();
    const prepared = await f.manager.prepareWorktree(f.store, local, first.id, proof);
    if (prepared.kind !== "prepared") throw new Error("Expected preparation.");
    const addArtifacts = () => {
      const ordinary = path.join(prepared.path, "generated-clone");
      const bare = path.join(prepared.path, "generated-bare");
      rawGit(f.directory, ["clone", f.upstream, ordinary]);
      rawGit(f.directory, ["clone", "--bare", f.upstream, bare]);
      writeFileSync(path.join(ordinary, "generated.txt"), "disposable generated contents");
      writeFileSync(path.join(prepared.path, "generated.txt"), "disposable artifact");
      return { ordinary, bare };
    };
    const artifacts = addArtifacts();
    const head = commit(f.upstream, "next dedicated review\n", f.head); const next = f.nextRevision(first.id, head);
    expect(await f.manager.prepareWorktree(f.store, local, next.id, proof)).toMatchObject({ kind: "prepared", path: prepared.path, headSha: head });
    expect(existsSync(artifacts.ordinary)).toBe(false); expect(existsSync(artifacts.bare)).toBe(false);
    expect(existsSync(path.join(prepared.path, "generated.txt"))).toBe(false);
    expect(rawGit(prepared.path, ["rev-parse", "HEAD"])).toBe(head);
    addArtifacts();
    const admin = rawGit(prepared.path, ["rev-parse", "--absolute-git-dir"]);
    f.update({ state: "closed" }); f.store.supersedeReview(next.id, proof, 30);
    expect(await f.manager.cleanupWorktree(f.store, local, next, proof)).toEqual({ kind: "cleaned" });
    expect(existsSync(prepared.path)).toBe(false); expect(existsSync(admin)).toBe(false);
    expect(f.store.getPullRequest(next)).toMatchObject({ worktreePath: null, cleanupPending: false, sessionId: uuid(500) });
    expect(rawGit(local.root, ["rev-parse", `refs/daynight/reviews/${first.id}/head`])).toBe(f.head);
    expect(rawGit(local.root, ["rev-parse", `refs/daynight/reviews/${next.id}/head`])).toBe(head);
    expect(rawGit(local.root, ["rev-parse", "HEAD"])).toBe(f.base);
  }, 60_000);
});
