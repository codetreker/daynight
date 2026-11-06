import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PullRequestObservation } from "../../../src/commands/review/model.js";
import { createReviewStoreFixtures } from "./store-fixtures.js";

const { uuid, repository, pr, stopped, connect, fixture } = createReviewStoreFixtures(true);

describe("durable SQLite initialization", () => {
  it("refuses a runtime write after another actor changes the declared format", () => {
    const { file, store, directory } = fixture();
    const sql = connect(file); sql.pragma("user_version=3");
    expect(() => store.registerRepository({ ...repository, remote: "https://github.com/o/r.git", localPath: directory })).toThrow("unsupported-version");
    expect(sql.prepare("SELECT count(*) AS count FROM repositories").get()).toEqual({ count: 0 });
  });
});

describe("atomic repository poll commits", () => {
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
