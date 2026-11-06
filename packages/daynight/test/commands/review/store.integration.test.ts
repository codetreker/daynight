import path from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { openStore } from "../../../src/commands/review/store.js";
import type { PullRequestObservation } from "../../../src/commands/review/model.js";
import { createReviewStoreFixtures } from "./store-fixtures.js";

const { fixtures, directories, uuid, repository, pr, stopped, connect, open, close, fixture, schemaV1 } = createReviewStoreFixtures(false);

describe("durable SQLite initialization", () => {
  it("creates a versioned WAL database at a real Unicode path", () => {
    const { file } = fixture();
    const sql = connect(file);
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect(sql.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([
      { name: "pull_requests" }, { name: "repositories" }, { name: "review_publications" }, { name: "reviews" },
    ]);
    for (const table of ["repositories", "pull_requests", "reviews"]) expect(sql.pragma(`foreign_key_list(${table})`)).toEqual([]);
  });

  it("refuses newer schemas without rewriting their version or contents", () => {
    const { file, store } = fixture();
    close(store);
    const sql = connect(file);
    sql.pragma("user_version = 3");
    sql.exec("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('preserved')");
    expect(() => openStore(file)).toThrow("unsupported-version");
    expect(sql.pragma("user_version", { simple: true })).toBe(3);
    expect(sql.prepare("SELECT value FROM future_data").get()).toEqual({ value: "preserved" });
  });

  it("resets an unknown unversioned structure before normal store writes", () => {
    const { file, store, directory } = fixture();
    close(store);
    const sql = connect(file);
    sql.exec("DROP TABLE repositories; DROP TABLE pull_requests; DROP TABLE reviews; DROP TABLE review_publications; CREATE TABLE reviews (sentinel TEXT); INSERT INTO reviews VALUES ('discarded')");
    sql.pragma("user_version = 0");
    const reset = open(file);
    expect(reset.listRepositories()).toEqual([]);
    reset.registerRepository({ ...repository, remote: "https://github.com/owner/repo.git", localPath: directory });
    expect(reset.getRepository(repository)).toMatchObject(repository);
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect((sql.pragma("table_info(reviews)") as { name: string }[]).map(row => row.name)).not.toContain("sentinel");
    expect(sql.prepare("SELECT count(*) AS total FROM review_publications").get()).toEqual({ total: 0 });
  });

  it("rejects an unknown nonzero schema without rewriting its version or contents", () => {
    const { file, store } = fixture(); close(store);
    const sql = connect(file); sql.exec("DROP TABLE reviews; CREATE TABLE reviews(sentinel TEXT); INSERT INTO reviews VALUES ('preserved')"); sql.pragma("user_version=1");
    expect(() => openStore(file)).toThrow("invalid-format");
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
    expect(sql.prepare("SELECT sentinel FROM reviews").get()).toEqual({ sentinel: "preserved" });
  });

  it("migrates schema1 transactionally while retaining sessions, worktrees, active process identities and historical completions", () => {
    const f = fixture(); f.initialize(); f.observe();
    const first = f.reserve(); f.prepare(first); const firstRunning = f.launch(first);
    f.store.completeReview({ reviewId: first.id, attempt: firstRunning.attemptCount }, stopped, 50);
    f.observe({ headSha: "head-b" }, 60);
    const active = f.reserve(3, 70); f.prepare(active); f.launch(active, 80);
    f.store.recordProcess({ reviewId: active.id, attempt: 1 }, { pid: 987, identity: "owned-process" });
    const repositoryBefore = f.store.getRepository(repository);
    const prBefore = f.store.getPullRequest(pr);
    const reviewsBefore = f.store.listReviews(pr);
    close(f.store);
    const sql = connect(f.file); sql.exec("DROP TABLE review_publications; PRAGMA user_version = 1");
    const migrated = open(f.file);
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect(migrated.getRepository(repository)).toEqual(repositoryBefore);
    expect(migrated.getPullRequest(pr)).toEqual(prBefore);
    expect(migrated.listReviews(pr)).toEqual(reviewsBefore);
    expect(migrated.getReviewPublication(first.id)).toEqual({ phase: "legacy", publisherId: null, identityFormat: "legacy", outcome: null, remoteReviewId: null, threadIds: [], followupConsumed: false });
    expect(migrated.getReviewPublication(active.id)).toEqual({ phase: "prepared", publisherId: null, identityFormat: "legacy", outcome: null, remoteReviewId: null, threadIds: [], followupConsumed: false });
  });

  it("rejects schema1 with an unexpected publication table without altering its data", () => {
    const f = fixture(); f.initialize(); f.observe(); const before = f.store.getPullRequest(pr); close(f.store);
    const sql = connect(f.file); sql.pragma("user_version = 1");
    expect(() => openStore(f.file)).toThrow("invalid-format");
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
    expect(sql.prepare("SELECT head_sha FROM pull_requests").get()).toEqual({ head_sha: before!.headSha });
    expect(sql.prepare("SELECT count(*) AS count FROM review_publications").get()).toEqual({ count: 0 });
  });

  it("migrates an independent schema1 lifecycle fixture without fabricating publisher identities", () => {
    mkdirSync(fixtures, { recursive: true });
    const directory = mkdtempSync(path.join(fixtures, "schema1-lifecycle-")); directories.push(directory);
    const file = path.join(directory, "state.sqlite");
    const sql = connect(file); sql.exec(schemaV1);
    const statuses = ["completed", "preparing", "running", "retry_wait", "interrupted", "failed", "superseded"] as const;
    const insert = sql.prepare(`INSERT INTO reviews(id,host,github_id,number,revision,head_sha,base_ref,base_sha,status,
      attempt_count,max_attempts,retry_at,process_owner,stdout_log_path,stderr_log_path,created_at,updated_at)
      VALUES(?, 'github.com','42',?,1,'head','main','pinned-base',?,1,3,?,'original-owner','stdout.log','stderr.log',10,20)`);
    statuses.forEach((status, index) => insert.run(`original-${status}`, index + 1, status, status === "retry_wait" ? 100 : null));
    const before = sql.prepare("SELECT * FROM reviews ORDER BY id").all();
    const migrated = open(file);
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect(sql.prepare("SELECT * FROM reviews ORDER BY id").all()).toEqual(before);
    for (const status of statuses) {
      const publication = migrated.getReviewPublication(`original-${status}`);
      if (status === "failed" || status === "superseded") expect(publication).toBeNull();
      else expect(publication).toEqual({
        phase: status === "completed" ? "legacy" : "prepared", publisherId: null, identityFormat: "legacy",
        outcome: null, remoteReviewId: null, threadIds: [], followupConsumed: false,
      });
    }
  });

  it("rolls back a publication migration that fails after its DDL has executed", () => {
    mkdirSync(fixtures, { recursive: true });
    const directory = mkdtempSync(path.join(fixtures, "independent-v1-")); directories.push(directory);
    const file = path.join(directory, "state.sqlite");
    const sql = connect(file); sql.exec(schemaV1);
    sql.exec("INSERT INTO repositories VALUES ('github.com','42','https://github.com/o/r.git','/original',0,1,2,NULL)");
    const exec = Database.prototype.exec;
    const failure = new Error("publication conversion failed after DDL");
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, statement: string) {
      const result = exec.call(this, statement);
      if (statement.includes("CREATE TABLE review_publications")) throw failure;
      return result;
    });
    expect(() => openStore(file, { onMigration: () => {} })).toThrow("migration-failed");
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
    expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name='review_publications'").get()).toBeUndefined();
    expect(sql.prepare("SELECT local_path FROM repositories").get()).toEqual({ local_path: "/original" });
  });

  it("exposes real write contention and leaves no partial observation", () => {
    const { store, file, initialize, observe } = fixture();
    initialize();
    const competing = open(file, { busyTimeoutMs: 10 });
    const sql = connect(file);
    sql.exec("BEGIN IMMEDIATE");
    expect(() => competing.observePullRequest(repository, { number: 101, state: "open", draft: false, headSha: "head", baseRef: "main", baseSha: "base" }, 20)).toThrow("database is locked");
    expect(store.getPullRequest(pr)).toBeNull();
    sql.exec("ROLLBACK");
    expect(observe()?.desiredRevision).toBe(1);
  });
});

describe("atomic repository poll commits", () => {
  it("rolls back initialization if the successful-poll metadata cannot commit", () => {
    const { store, file, register } = fixture();
    register();
    const sql = connect(file);
    sql.exec("CREATE TRIGGER reject_poll BEFORE UPDATE OF last_poll_at ON repositories BEGIN SELECT RAISE(ABORT, 'poll rejected'); END");
    expect(() => store.applyRepositoryPoll(repository, { kind: "initialize", startPrNumber: 0 }, 20)).toThrow("poll rejected");
    expect(store.getRepository(repository)).toMatchObject({ startPrNumber: null, initializedAt: null, lastPollAt: null });
    sql.exec("DROP TRIGGER reject_poll");
    expect(store.applyRepositoryPoll(repository, { kind: "initialize", startPrNumber: 0 }, 21)).toMatchObject({ startPrNumber: 0, initializedAt: 21, lastPollAt: 21 });
    close(store);
    expect(open(file).getRepository(repository)).toMatchObject({ startPrNumber: 0, initializedAt: 21, lastPollAt: 21 });
  });

  it.each(["second observation", "success marker"])("rolls back the entire snapshot when its %s fails", (failure) => {
    const { store, file, register } = fixture();
    register();
    store.applyRepositoryPoll(repository, { kind: "initialize", startPrNumber: 100 }, 10);
    const observations = (headSha: string): PullRequestObservation[] => [101, 102].map((number) => ({
      number, state: "open", draft: false, headSha, baseRef: "main", baseSha: "base",
    }));
    store.applyRepositoryPoll(repository, { kind: "snapshot", observations: observations("old") }, 20);
    const sql = connect(file);
    sql.exec(failure === "second observation"
      ? "CREATE TRIGGER reject_snapshot BEFORE UPDATE ON pull_requests WHEN NEW.number = 102 BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END"
      : "CREATE TRIGGER reject_snapshot BEFORE UPDATE OF last_poll_at ON repositories BEGIN SELECT RAISE(ABORT, 'snapshot rejected'); END");
    expect(() => store.applyRepositoryPoll(repository, { kind: "snapshot", observations: observations("new") }, 30)).toThrow("snapshot rejected");
    store.recordPollError(repository, "snapshot rejected");
    close(store);
    sql.exec("DROP TRIGGER reject_snapshot");
    const reopened = open(file);
    expect(reopened.listPullRequests(repository).map(({ number, headSha, desiredRevision }) => ({ number, headSha, desiredRevision }))).toEqual([
      { number: 101, headSha: "old", desiredRevision: 1 },
      { number: 102, headSha: "old", desiredRevision: 1 },
    ]);
    expect(reopened.getRepository(repository)).toMatchObject({ lastPollAt: 20, lastPollError: "snapshot rejected" });
    expect(reopened.applyRepositoryPoll(repository, { kind: "snapshot", observations: observations("new") }, 31)).toMatchObject({ lastPollAt: 31, lastPollError: null });
    expect(reopened.listPullRequests(repository).map(({ desiredRevision }) => desiredRevision)).toEqual([2, 2]);
  });
});

describe("repository identity and permanent initialization boundary", () => {
  it("distinguishes uninitialized from an empty repository and preserves a zero boundary across restart", () => {
    const { store, file, register, initialize, observe } = fixture();
    expect(register().startPrNumber).toBeNull();
    expect(() => observe()).toThrow("initialization has not completed");
    expect(initialize(0).startPrNumber).toBe(0);
    expect(store.initializeRepository(repository, 999, 500).startPrNumber).toBe(0);
    close(store);
    const reopened = open(file);
    expect(reopened.getRepository(repository)).toMatchObject({ startPrNumber: 0, initializedAt: 10 });
    expect(reopened.observePullRequest(repository, { number: 1, state: "open", draft: false, headSha: "head", baseRef: "main", baseSha: "base" }, 600)?.desiredRevision).toBe(1);
  });

  it("keys by host and stable GitHub ID, preserves poll errors, and ignores excluded PRs forever", () => {
    const { store, initialize, observe, register, directory, file } = fixture();
    initialize();
    expect(observe({ number: 100 })).toBeNull();
    expect(observe({ number: 99, draft: true })).toBeNull();
    store.recordPollSuccess(repository, 30);
    store.recordPollError(repository, "API unavailable");
    store.registerRepository({ host: "GITHUB.COM", githubId: "42", remote: "git@github.com:renamed/repository.git", localPath: path.join(directory, "repo") });
    expect(store.getRepository(repository)).toMatchObject({ startPrNumber: 100, lastPollAt: 30, lastPollError: "API unavailable" });
    register({ host: "enterprise.example:8443", githubId: "42" });
    expect(store.getRepository({ host: "enterprise.example:8443", githubId: "42" })?.startPrNumber).toBeNull();
    expect(store.listRepositories()).toHaveLength(2);
    close(store);
    const reopened = open(file);
    expect(reopened.observePullRequest(repository, { number: 100, state: "open", draft: false, headSha: "new-head", baseRef: "changed", baseSha: "base" }, 100)).toBeNull();
    expect(reopened.listPullRequests(repository)).toEqual([]);
    expect(reopened.recordPollSuccess(repository, 101).lastPollError).toBeNull();
  });
});

describe("persistent attempts, sessions and recovery", () => {
  it("persists launch intent and all current process/log references before restart without implicit recovery", () => {
    const { store, file, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review); const running = launch(review);
    const identity = { reviewId: review.id, attempt: 1 };
    store.recordProcess(identity, { pid: 12345, identity: "creation-token" });
    store.markSessionEstablished(pr);
    close(store);
    const reopened = open(file);
    expect(reopened.getReview(review.id)).toMatchObject({ status: "running", attemptCount: 1, maxAttempts: 3, processOwner: uuid(700), processId: 12345, processIdentity: "creation-token", stdoutLogPath: running.stdoutLogPath, stderrLogPath: running.stderrLogPath });
    expect(reopened.getPullRequest(pr)).toMatchObject({ sessionId: uuid(500), sessionEstablished: true });
    expect(reopened.listCandidates(500)).toEqual([]);
    expect(() => reopened.recordProcess(identity, { pid: 54321, identity: "replacement" })).toThrow("different process identity");
  });

  it("reuses a due review, session and pinned target, then suppresses an exhausted revision across restart and fresh IDs", () => {
    const { store, file, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const review = reserve(2); prepare(review); launch(review);
    store.retryReview({ reviewId: review.id, attempt: 1 }, stopped, { error: "missing marker", retryAt: 100 }, 50);
    expect(store.listCandidates(99)).toEqual([]);
    expect(store.reserveReview(pr, { reviewId: uuid(8), sessionId: uuid(501), maxAttempts: 99 }, 99)).toBeNull();
    expect(store.listCandidates(100)[0]?.review?.id).toBe(review.id);
    const retry = store.reserveReview(pr, { reviewId: uuid(8), sessionId: uuid(501), maxAttempts: 99 }, 100);
    expect(retry).toMatchObject({ id: review.id, status: "preparing", baseSha: "pinned-base", attemptCount: 1, maxAttempts: 2 });
    const running = launch(retry!, 110);
    expect(() => store.completeReview({ reviewId: review.id, attempt: 1 }, stopped, 111)).toThrow("current running attempt");
    expect(store.retryReview({ reviewId: review.id, attempt: running.attemptCount }, stopped, { error: "still missing marker", retryAt: 200 }, 120).status).toBe("failed");
    close(store);
    const reopened = open(file);
    expect(reopened.listCandidates(1000)).toEqual([]);
    expect(reopened.reserveReview(pr, { reviewId: uuid(9), sessionId: uuid(502), maxAttempts: 100 }, 1000)).toBeNull();
    expect(reopened.listReviews(pr)).toHaveLength(1);
    reopened.observePullRequest(repository, { number: 101, state: "open", draft: false, headSha: "head-b", baseRef: "main", baseSha: "base" }, 1010);
    expect(reopened.reserveReview(pr, { reviewId: uuid(9), sessionId: uuid(502), maxAttempts: 3 }, 1020)?.revision).toBe(2);
    expect(reopened.getPullRequest(pr)?.sessionId).toBe(uuid(500));
  });

  it("consumes an attempt for interrupted spawn intent and requires explicit process exclusion before resolution", () => {
    const { store, file, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const review = reserve(1); prepare(review); launch(review);
    close(store);
    const reopened = open(file);
    expect(reopened.getReview(review.id)).toMatchObject({ status: "running", processId: null, attemptCount: 1 });
    reopened.markInterrupted(review.id, "previous CLI stopped unexpectedly", 100);
    expect(reopened.listCandidates(101)).toEqual([]);
    expect(() => reopened.resolveInterrupted(review.id, { operationsStopped: true, processesExcluded: false } as never, 110, 105)).toThrow("exclude any previous");
    expect(() => reopened.supersedeReview(review.id, stopped, 106)).toThrow("cannot be superseded");
    expect(reopened.resolveInterrupted(review.id, stopped, 110, 107).status).toBe("failed");
    expect(reopened.getPullRequest(pr)?.completedRevision).toBe(0);
    expect(reopened.listCandidates(111)).toEqual([]);
  });
});

describe("owned worktree cleanup and transaction guarantees", () => {
  it("defers cleanup until review exclusion and preserves session/history through closure, cleanup and reopening", () => {
    const { store, file, directory, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review); launch(review); store.markSessionEstablished(pr);
    const worktree = path.join(directory, "repo", ".worktrees", "pr-101");
    expect(observe({ state: "merged" }, 45)).toMatchObject({ cleanupPending: true, worktreePath: worktree });
    expect(() => store.completeCleanup(pr, worktree, stopped)).toThrow("active review blocks");
    store.markInterrupted(review.id, "closed while running", 46);
    expect(() => store.completeCleanup(pr, worktree, stopped)).toThrow("active review blocks");
    store.resolveInterrupted(review.id, stopped, 50, 47);
    expect(store.completeCleanup(pr, worktree, stopped)).toMatchObject({ cleanupPending: false, worktreePath: null, sessionId: uuid(500), sessionEstablished: true });
    close(store);
    const reopened = open(file);
    expect(reopened.listReviews(pr)).toHaveLength(1);
    expect(reopened.observePullRequest(repository, { number: 101, state: "open", draft: false, headSha: "head-a", baseRef: "main", baseSha: "base-a" }, 60)).toMatchObject({ desiredRevision: 2, completedRevision: 0, sessionId: uuid(500), sessionEstablished: true });
    reopened.registerWorktree(pr, worktree);
    expect(reopened.reserveReview(pr, { reviewId: uuid(9), sessionId: uuid(501), maxAttempts: 3 }, 70)?.revision).toBe(2);
    expect(reopened.getPullRequest(pr)?.sessionId).toBe(uuid(500));
  });

  it("retains cleanup failures through reopening until stopped cleanup is explicitly cancelled", () => {
    const { store, file, initialize, observe, reserve, prepare } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review);
    const worktree = store.getPullRequest(pr)!.worktreePath!;
    observe({ state: "closed" }, 45);
    expect(store.listCleanupCandidates()).toEqual([]);
    store.supersedeReview(review.id, stopped, 46);
    expect(store.listActiveReviews()).toEqual([]);
    expect(store.listCleanupCandidates().map(({ number }) => number)).toEqual([101]);
    store.recordCleanupError(pr, worktree, "git worktree remove failed");
    close(store);
    const reopened = open(file);
    expect(reopened.listCleanupCandidates()[0]).toMatchObject({ cleanupPending: true, cleanupError: "git worktree remove failed" });
    reopened.observePullRequest(repository, { number: 101, state: "open", draft: false, headSha: "head-a", baseRef: "main", baseSha: "base-a" }, 50);
    expect(reopened.getPullRequest(pr)).toMatchObject({ cleanupPending: true, cleanupError: "git worktree remove failed" });
    expect(reopened.listCleanupCandidates().map(({ number }) => number)).toEqual([101]);
    expect(reopened.listCandidates(55)).toEqual([]);
    expect(reopened.reserveReview(pr, { reviewId: uuid(9), sessionId: uuid(501), maxAttempts: 3 }, 55)).toBeNull();
    reopened.recordCleanupError(pr, worktree, "reopened while removal was uncertain");
    expect(reopened.getPullRequest(pr)?.cleanupError).toBe("reopened while removal was uncertain");
    expect(() => reopened.cancelCleanup(pr, worktree, { ...stopped, operationsStopped: false } as unknown as typeof stopped)).toThrow("operations have stopped");
    expect(() => reopened.cancelCleanup(pr, worktree, { ...stopped, processesExcluded: false } as unknown as typeof stopped)).toThrow("exclude any previous agent");
    expect(() => reopened.cancelCleanup(pr, `${worktree}-other`, stopped)).toThrow("does not match cleanup");
    expect(reopened.cancelCleanup(pr, worktree, stopped)).toMatchObject({ cleanupPending: false, cleanupError: null, worktreePath: worktree, sessionId: uuid(500) });
    expect(reopened.listCleanupCandidates()).toEqual([]);
    reopened.observePullRequest(repository, { number: 101, state: "closed", draft: false, headSha: "head-a", baseRef: "main", baseSha: "base-a" }, 60);
    reopened.recordCleanupError(pr, worktree, "remove failed again");
    expect(reopened.completeCleanup(pr, worktree, stopped)).toMatchObject({ cleanupPending: false, cleanupError: null });
  });
});
