import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStore, type Store } from "../../../src/commands/review/store.js";
import type { PullRequestObservation, ReviewState } from "../../../src/commands/review/model.js";

const fixtures = path.resolve(import.meta.dirname, "../../../../../.tmp/store-tests");
const directories: string[] = [];
const stores = new Set<Store>();
const schemaV1 = readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8");
const connections = new Set<Database.Database>();
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const repository = { host: "github.com", githubId: "42" };
const pr = { ...repository, number: 101 };
const stopped = { operationsStopped: true, processesExcluded: true } as const;

const connect = (file: string): Database.Database => {
  const connection = new Database(file);
  connections.add(connection);
  return connection;
};
const open = (file: string, options?: { busyTimeoutMs?: number }): Store => {
  const store = openStore(file, { ...options, onMigration: () => {} });
  stores.add(store);
  return store;
};
const close = (store: Store): void => { store.close(); stores.delete(store); };
const fixture = () => {
  mkdirSync(fixtures, { recursive: true });
  const directory = mkdtempSync(path.join(fixtures, "SQLite 用户 "));
  directories.push(directory);
  const file = path.join(directory, "state.sqlite");
  const store = open(file);
  let nextId = 1;
  const register = (target = repository) => store.registerRepository({ ...target, remote: "https://github.com/owner/repo.git", localPath: path.join(directory, "repo") });
  const initialize = (cutoff = 100) => { register(); return store.initializeRepository(repository, cutoff, 10); };
  const observe = (overrides: Partial<PullRequestObservation> = {}, now = 20) => store.observePullRequest(repository, {
    number: 101, state: "open", draft: false, headSha: "head-a", baseRef: "main", baseSha: "base-a", ...overrides,
  }, now);
  const reserve = (maxAttempts = 3, now = 30): ReviewState => {
    const review = store.reserveReview(pr, { reviewId: uuid(nextId++), sessionId: uuid(500), maxAttempts }, now);
    if (review === null) throw new Error("Expected a review reservation.");
    return review;
  };
  const prepare = (review: ReviewState): void => {
    store.registerWorktree(pr, path.join(directory, "repo", ".worktrees", "pr-101"));
    store.pinReviewBase(review.id, "pinned-base", 35);
  };
  const launch = (review: ReviewState, now = 40): ReviewState => store.startAttempt(review.id, {
    processOwner: uuid(700), stdoutLogPath: path.join(directory, "logs", review.id, String(review.attemptCount + 1), "stdout.log"),
    stderrLogPath: path.join(directory, "logs", review.id, String(review.attemptCount + 1), "stderr.log"),
  }, now);
  return { directory, file, store, register, initialize, observe, reserve, prepare, launch };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const connection of connections) if (connection.open) connection.close();
  connections.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

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

  it("rejects an unknown unversioned structure before creating schema objects", () => {
    const { file, store } = fixture();
    close(store);
    const sql = connect(file);
    sql.exec("DROP TABLE repositories; DROP TABLE pull_requests; DROP TABLE reviews; DROP TABLE review_publications; CREATE TABLE reviews (sentinel TEXT); INSERT INTO reviews VALUES ('retained')");
    sql.pragma("user_version = 0");
    expect(() => openStore(file)).toThrow("invalid-format");
    expect(sql.pragma("user_version", { simple: true })).toBe(0);
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "reviews" }]);
    expect(sql.prepare("SELECT sentinel FROM reviews").get()).toEqual({ sentinel: "retained" });
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

  it("refuses a runtime write after another actor changes the declared format", () => {
    const { file, store } = fixture();
    const sql = connect(file); sql.pragma("user_version=3");
    expect(() => store.registerRepository({ ...repository, remote: "https://github.com/o/r.git", localPath: path.dirname(file) })).toThrow("unsupported-version");
    expect(sql.prepare("SELECT count(*) AS count FROM repositories").get()).toEqual({ count: 0 });
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

  it("requires initialization and one observation per PR in each snapshot", () => {
    const { store, register } = fixture();
    register();
    expect(() => store.applyRepositoryPoll(repository, { kind: "snapshot", observations: [] }, 1)).toThrow("initialization has not completed");
    store.applyRepositoryPoll(repository, { kind: "initialize", startPrNumber: 0 }, 2);
    expect(store.applyRepositoryPoll(repository, { kind: "snapshot", observations: [] }, 3).lastPollAt).toBe(3);
    const observation: PullRequestObservation = { number: 101, state: "open", draft: false, headSha: "head", baseRef: "main", baseSha: "base" };
    expect(() => store.applyRepositoryPoll(repository, { kind: "snapshot", observations: [observation, { ...observation, headSha: "changed" }] }, 4)).toThrow("duplicate PR 101");
    expect(store.listPullRequests(repository)).toEqual([]);
    expect(store.getRepository(repository)?.lastPollAt).toBe(3);
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

describe("observed snapshots and review revisions", () => {
  it("tracks Draft changes without scheduling and increments only once for each triggering snapshot", () => {
    const { store, initialize, observe } = fixture();
    initialize();
    expect(observe({ draft: true })?.desiredRevision).toBe(1);
    expect(store.listCandidates(50)).toEqual([]);
    expect(observe({ draft: true, headSha: "head-b" }, 21)?.desiredRevision).toBe(2);
    expect(observe({ draft: false, headSha: "head-c", baseRef: "release" }, 22)?.desiredRevision).toBe(3);
    expect(store.listCandidates(50).map(({ pullRequest }) => pullRequest.desiredRevision)).toEqual([3]);
    expect(observe({ draft: false, headSha: "head-c", baseRef: "release", baseSha: "base-b" }, 23)?.desiredRevision).toBe(3);
    expect(observe({ draft: false, headSha: "head-c", baseRef: "release", baseSha: "base-b" }, 24)?.desiredRevision).toBe(3);
    expect(observe({ state: "closed", headSha: "head-c", baseRef: "release" }, 25)?.desiredRevision).toBe(3);
    expect(store.listCandidates(50)).toEqual([]);
    expect(observe({ headSha: "head-c", baseRef: "release" }, 26)?.desiredRevision).toBe(4);
  });

  it("does not schedule a base-only update after completion and preserves newer triggers behind an older completion", () => {
    const { store, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe();
    const review = reserve(); prepare(review);
    const running = launch(review);
    observe({ headSha: "head-b", baseRef: "release" }, 41);
    expect(store.listCandidates(42)).toEqual([]);
    expect(store.reserveReview(pr, { reviewId: uuid(10), sessionId: uuid(501), maxAttempts: 3 }, 43)).toBeNull();
    store.completeReview({ reviewId: review.id, attempt: running.attemptCount }, stopped, 50);
    expect(store.getPullRequest(pr)).toMatchObject({ desiredRevision: 2, completedRevision: 1, sessionId: uuid(500) });
    const next = reserve();
    expect(next).toMatchObject({ revision: 2, headSha: "head-b", baseRef: "release" });
    prepare(next); const nextRunning = launch(next, 60);
    store.completeReview({ reviewId: next.id, attempt: nextRunning.attemptCount }, stopped, 70);
    expect(observe({ headSha: "head-b", baseRef: "release", baseSha: "base-new" }, 80)?.desiredRevision).toBe(2);
    expect(store.listCandidates(90)).toEqual([]);
  });

  it.each([
    { draft: true }, { state: "closed" as const }, { state: "merged" as const }, { headSha: "new-head" }, { baseRef: "release" },
  ])("refuses launch if observed readiness or captured target changes: %j", (change) => {
    const { initialize, observe, reserve, prepare, launch, store } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review);
    observe(change, 39);
    expect(() => launch(review)).toThrow("no longer ready");
    expect(store.getReview(review.id)).toMatchObject({ status: "preparing", attemptCount: 0 });
  });

  it("retains immutable captured head, branch, revision and pinned base while observations advance", () => {
    const { store, initialize, observe, reserve, prepare } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review);
    expect(store.pinReviewBase(review.id, "pinned-base", 36).baseSha).toBe("pinned-base");
    expect(() => store.pinReviewBase(review.id, "different-base", 37)).toThrow("immutable");
    observe({ headSha: "head-b", baseRef: "release" }, 38);
    expect(store.getReview(review.id)).toMatchObject({ revision: 1, headSha: "head-a", baseRef: "main", baseSha: "pinned-base" });
    expect(store.reserveReview(pr, { reviewId: uuid(9), sessionId: uuid(9), maxAttempts: 3 }, 39)).toBeNull();
    expect(() => store.supersedeReview(review.id, { operationsStopped: false } as never, 40)).toThrow("operations have stopped");
    store.supersedeReview(review.id, stopped, 41);
    expect(reserve().revision).toBe(2);
  });
});

describe("persistent attempts, sessions and recovery", () => {
  it("clears only the exactly excluded current process and keeps the running attempt intent", () => {
    const { store, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review); launch(review);
    const attempt = { reviewId: review.id, attempt: 1 };
    const expected = { processId: 12345, processIdentity: "discovery" };
    store.recordProcess(attempt, { pid: expected.processId, identity: expected.processIdentity });
    const before = store.getReview(review.id)!;
    expect(() => store.clearProcess(attempt, expected, { processesExcluded: false } as never)).toThrow("exclude any previous agent processes");
    expect(() => store.clearProcess({ ...attempt, attempt: 2 }, expected, stopped)).toThrow("current running attempt");
    expect(() => store.clearProcess(attempt, { ...expected, processId: 12346 }, stopped)).toThrow("process identity changed");
    expect(() => store.clearProcess(attempt, { ...expected, processIdentity: "other" }, stopped)).toThrow("process identity changed");
    expect(store.getReview(review.id)).toEqual(before);
    expect(store.clearProcess(attempt, expected, stopped)).toEqual({ ...before, processId: null, processIdentity: null });
    store.recordProcess(attempt, { pid: 54321, identity: "review" });
    expect(() => store.clearProcess(attempt, expected, stopped)).toThrow("process identity changed");
    expect(store.getReview(review.id)).toMatchObject({ processId: 54321, processIdentity: "review", attemptCount: 1, status: "running" });
    store.retryReview(attempt, stopped, { error: "incomplete", retryAt: 100 }, 50);
    expect(() => store.clearProcess(attempt, { processId: null, processIdentity: null }, stopped)).toThrow("current running attempt");
  });

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

  it("can recover an interrupted preparation without consuming an agent attempt and supersedes stale retry work", () => {
    const { store, initialize, observe, reserve } = fixture();
    initialize(); observe(); const first = reserve();
    store.markInterrupted(first.id, "interrupted before spawn", 40);
    expect(store.resolveInterrupted(first.id, stopped, 50, 45)).toMatchObject({ status: "retry_wait", attemptCount: 0 });
    observe({ headSha: "head-b" }, 46);
    const next = reserve(3, 47);
    expect(next).toMatchObject({ revision: 2, attemptCount: 0 });
    expect(store.getReview(first.id)?.status).toBe("superseded");
    store.deferPreparation(next.id, stopped, { error: "fetch unavailable", retryAt: 60 }, 48);
    expect(store.getReview(next.id)).toMatchObject({ status: "retry_wait", attemptCount: 0 });
    expect(reserve(3, 60)).toMatchObject({ id: next.id, attemptCount: 0 });
  });

  it("keeps uncertain old execution blocking newer targets until exclusion is confirmed", () => {
    const { store, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const first = reserve(); prepare(first); launch(first);
    store.markInterrupted(first.id, "uncertain child", 45);
    observe({ headSha: "head-b" }, 46);
    expect(store.reserveReview(pr, { reviewId: uuid(99), sessionId: uuid(501), maxAttempts: 3 }, 47)).toBeNull();
    expect(store.resolveInterrupted(first.id, stopped, 60, 50).status).toBe("superseded");
    expect(reserve(3, 51).revision).toBe(2);
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

  it("requires exclusion of active reviews before cancelling reopened cleanup and preserves ownership", () => {
    const { store, directory, initialize, observe, reserve, prepare } = fixture();
    initialize(); observe(); const review = reserve(); prepare(review);
    const worktree = store.getPullRequest(pr)!.worktreePath!;
    observe({ state: "closed" }, 45);
    expect(() => store.cancelCleanup(pr, worktree, stopped)).toThrow("Only a reopened PR");
    expect(observe({}, 50)).toMatchObject({ cleanupPending: true, worktreePath: worktree, desiredRevision: 2 });
    expect(() => store.completeCleanup(pr, worktree, stopped)).toThrow("reopened PR");
    expect(() => store.cancelCleanup(pr, worktree, stopped)).toThrow("active review blocks");
    store.supersedeReview(review.id, stopped, 51);
    expect(store.cancelCleanup(pr, worktree, stopped)).toMatchObject({ cleanupPending: false, worktreePath: worktree, desiredRevision: 2 });
    expect(() => store.cancelCleanup(pr, worktree, stopped)).toThrow("does not match cleanup");
    expect(() => store.registerWorktree(pr, path.join(directory, "different"))).toThrow("different worktree");
    expect(() => store.registerRepository({ ...repository, remote: "https://github.com/owner/repo.git", localPath: path.join(directory, "elsewhere") })).toThrow("cannot change its local path");
  });

  it.each(["preparing", "running", "retry_wait", "interrupted"] as const)("enforces the active review uniqueness constraint for %s", (status) => {
    const { store, file, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const review = reserve();
    if (status !== "preparing") {
      prepare(review); launch(review);
      if (status === "retry_wait") store.retryReview({ reviewId: review.id, attempt: 1 }, stopped, { error: "missing marker", retryAt: 60 }, 50);
      if (status === "interrupted") store.markInterrupted(review.id, "uncertain child", 50);
    }
    expect(store.listActiveReviews().map(({ status: current }) => current)).toEqual([status]);
    const sql = connect(file);
    expect(() => sql.prepare(`INSERT INTO reviews(id, host, github_id, number, revision, head_sha, base_ref, status, max_attempts, created_at, updated_at)
      SELECT ?, host, github_id, number, revision, head_sha, base_ref, 'preparing', max_attempts, 100, 100 FROM reviews WHERE id = ?`).run(uuid(99), review.id)).toThrow("UNIQUE constraint failed");
    expect(store.listReviews(pr)).toHaveLength(1);
  });

  it("rolls back session creation together with failed reservation and rolls back completion together with its revision", () => {
    const { store, file, initialize, observe, reserve, prepare, launch } = fixture();
    initialize(); observe(); const sql = connect(file);
    sql.exec("CREATE TRIGGER reject_review BEFORE INSERT ON reviews BEGIN SELECT RAISE(ABORT, 'reservation rejected'); END");
    expect(() => reserve()).toThrow("reservation rejected");
    expect(store.getPullRequest(pr)?.sessionId).toBeNull();
    expect(store.listReviews(pr)).toEqual([]);
    sql.exec("DROP TRIGGER reject_review");
    const review = reserve(); prepare(review); launch(review);
    sql.exec("CREATE TRIGGER reject_completion BEFORE UPDATE OF completed_revision ON pull_requests BEGIN SELECT RAISE(ABORT, 'completion rejected'); END");
    expect(() => store.completeReview({ reviewId: review.id, attempt: 1 }, stopped, 50)).toThrow("completion rejected");
    expect(store.getReview(review.id)?.status).toBe("running");
    expect(store.getPullRequest(pr)?.completedRevision).toBe(0);
    sql.exec("DROP TRIGGER reject_completion");
    expect(store.completeReview({ reviewId: review.id, attempt: 1 }, stopped, 51).status).toBe("completed");
    expect(store.getPullRequest(pr)?.completedRevision).toBe(1);
  });
});
