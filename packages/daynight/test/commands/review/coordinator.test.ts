import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { CoordinatorOptions } from "../../../src/commands/review/coordinator.js";
import { createCopilotRunner } from "../../../src/commands/review/adapters/copilot.js";
import { createGitManager, GitCommandError } from "../../../src/commands/review/adapters/worktrees.js";
import { executeCommand, GitHubApiError } from "../../../src/commands/review/adapters/github.js";
import type { GitHubClient } from "../../../src/commands/review/adapters/github.js";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";

import { createCoordinatorFixtures } from "./coordinator-fixtures.js";

const { proof, uuid, deferred, waitFor, untilAborted, observation, fixture } = createCoordinatorFixtures(true);

describe("foreground review coordination", () => {
  it("keeps independent sessions for different pull requests", async () => {
    const f = fixture(); f.update(1); f.update(2); f.start();
    await waitFor(() => f.store.getPullRequest(f.pr(1))?.completedRevision === 1 && f.store.getPullRequest(f.pr(2))?.completedRevision === 1, "both reviews");
    const first = f.store.getPullRequest(f.pr(1))!.sessionId, second = f.store.getPullRequest(f.pr(2))!.sessionId;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first).toMatch(uuidPattern); expect(second).toMatch(uuidPattern); expect(second).not.toBe(first);
    expect(f.launched).toHaveLength(2);
    expect(f.launched.map(({ review, session }) => [review.number, session])).toEqual(expect.arrayContaining([[1, first], [2, second]]));
  });

  it("waits for all unresolved conversations without reserving resources, including outdated and other-author threads", async () => {
    const f = fixture(); f.update(1);
    f.threads.push({ id: "outdated-other-author", reviewId: "other-review", isResolved: false });
    f.start();
    await waitFor(() => f.polls[0]! >= 3, "thread-blocked polls");
    expect(f.launched).toEqual([]); expect(f.prepared).toEqual([]);
    expect(f.store.getPullRequest(f.pr())!.sessionId).toBeNull();
    f.threads[0]!.isResolved = true;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "resolved initial admission");
  });

  it("excludes positively identified private PENDING threads but blocks unknown-parent unresolved conversations", async () => {
    const f = fixture(); f.update(1);
    f.publications.push({ id: "private-draft", authorId: "viewer", headSha: "a".repeat(40), state: "PENDING", body: "number=1 private draft" });
    f.threads.push({ id: "private", reviewId: "private-draft", isResolved: false }, { id: "unknown", reviewId: null, isResolved: false });
    f.start(); await waitFor(() => f.polls[0]! >= 3, "unknown parent blocks");
    expect(f.launched).toHaveLength(0);
    f.threads[1]!.isResolved = true;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "private draft does not block");
    expect(f.launched).toHaveLength(1);
  });

  it("arms exactly one same-head successor after every native conversation resolves", async () => {
    const f = fixture(); f.update(1);
    f.run(async (review) => {
      if (review.revision === 1) {
        f.publications.push({ id: "comment-review", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\n<!-- daynight review=${review.id} revision=1 head=${review.headSha} -->` });
        f.threads.push({ id: "description", reviewId: "comment-review", isResolved: false }, { id: "other", reviewId: "someone-else", isResolved: false });
      }
      return true;
    });
    f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "comment completion");
    const first = f.store.listReviews(f.pr())[0]!;
    expect(f.store.getReviewPublication(first.id)).toMatchObject({ phase: "verified", outcome: "commented", publisherId: "viewer", threadIds: ["description"], followupConsumed: false });
    f.threads[0]!.isResolved = true;
    const polls = f.polls[0]!; await waitFor(() => f.polls[0]! >= polls + 3, "other unresolved conversation");
    expect(f.launched).toHaveLength(1);
    f.threads[1]!.isResolved = true;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "same-head follow-up");
    const after = f.polls[0]!; await waitFor(() => f.polls[0]! >= after + 3, "settled repeated polls");
    expect(f.launched.map(({ review }) => [review.revision, review.headSha])).toEqual([[1, "a".repeat(40)], [2, "a".repeat(40)]]);
    expect(f.launched[1]!.session).toBe(f.launched[0]!.session);
    expect(f.store.getReviewPublication(first.id)!.followupConsumed).toBe(true);
  });

  it("does not miss resolution before process completion or the first publication read", async () => {
    const f = fixture(); f.update(1);
    f.run(async (review) => {
      if (review.revision === 1) {
        f.publications.push({ id: "fast-comment", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\ndaynight review=${review.id} revision=1 head=${review.headSha}` });
        f.threads.push({ id: "already-resolved", reviewId: "fast-comment", isResolved: true });
      }
      return true;
    });
    f.start(); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "already resolved follow-up");
    expect(f.launched).toHaveLength(2);
  });

  it("coalesces new commits with a comment follow-up and waits for unresolved conversations", async () => {
    const f = fixture(); f.update(1);
    f.run(async (review) => {
      if (review.revision === 1) {
        f.publications.push({ id: "old-comment", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\ndaynight review=${review.id} revision=1 head=${review.headSha}` });
        f.threads.push({ id: "still-open", reviewId: "old-comment", isResolved: false });
      }
      return true;
    });
    f.start(); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "old comment");
    f.update(1, { headSha: "e".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.desiredRevision === 2, "new pending head");
    const polls = f.polls[0]!; await waitFor(() => f.polls[0]! >= polls + 3, "new head waiting threads");
    expect(f.launched).toHaveLength(1);
    f.threads[0]!.isResolved = true;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "coalesced latest head");
    expect(f.launched.map(({ review }) => review.revision)).toEqual([1, 2]);
    expect(f.store.getPullRequest(f.pr())!.desiredRevision).toBe(2);
  });

  it("confirms a marker-loss retry despite its own open conversation", async () => {
    const f = fixture(); f.update(1);
    f.run(async (review) => {
      if (review.attemptCount === 1) {
        f.publications.push({ id: "lost-marker", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\ndaynight review=${review.id} revision=1 head=${review.headSha}` });
        f.threads.push({ id: "open-own", reviewId: "lost-marker", isResolved: false });
        return false;
      }
      return true;
    });
    f.start(); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "same-round confirmation");
    expect(f.launched).toHaveLength(2);
    expect(f.launched[1]!.review.id).toBe(f.launched[0]!.review.id);
    expect(f.store.getPullRequest(f.pr())!.desiredRevision).toBe(1);
  });

  it("waits through a foreign conversation opened during backoff without spending the remaining attempt", async () => {
    const f = fixture(); f.update(1); f.configuration.maxAttempts = 2;
    f.run(async (review) => {
      if (review.attemptCount === 1) {
        f.threads.push({ id: "foreign-during-backoff", reviewId: "foreign-review", isResolved: false });
        return false;
      }
      return true;
    });
    f.start();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "retry_wait", "first failed attempt");
    const first = f.store.listReviews(f.pr())[0]!;
    const polls = f.polls[0]!; await waitFor(() => f.polls[0]! >= polls + 5, "foreign conversation waiting beyond backoff");
    expect(f.launched).toHaveLength(1); expect(f.prepared).toHaveLength(1);
    expect(f.store.getReview(first.id)).toMatchObject({ status: "retry_wait", attemptCount: 1 });
    f.threads[0]!.isResolved = true;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "same-round resume after foreign conversation resolution");
    expect(f.launched.map(({ review }) => [review.id, review.attemptCount])).toEqual([[first.id, 1], [first.id, 2]]);
  });

  it("confirms a captured actor's marker-loss COMMENT read-only after the reader account switches", async () => {
    const f = fixture(); f.update(1);
    const snapshot = f.client.getPullRequestReviewSnapshot;
    f.client.getPullRequestReviewSnapshot = async (...args) => ({ ...await snapshot(...args), viewerId: f.launched.length === 0 ? "viewer" : "new-reader" });
    f.run(async (review, input) => {
      expect(input.publisherId).toBe("viewer");
      if (review.attemptCount === 1) {
        f.publications.push({ id: "actor-a-comment", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\ndaynight review=${review.id} revision=1 head=${review.headSha}` });
        f.threads.push({ id: "actor-a-thread", reviewId: "actor-a-comment", isResolved: false });
        return false;
      }
      return true;
    });
    f.start(); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "readonly actor-a confirmation under reader-b");
    expect(f.launched).toHaveLength(2);
    expect(f.launched[1]!.review.id).toBe(f.launched[0]!.review.id);
    expect(f.store.getReviewPublication(f.launched[0]!.review.id)).toMatchObject({ publisherId: "viewer", outcome: "commented", remoteReviewId: "actor-a-comment" });
    expect(f.publications).toHaveLength(1);
  });

  it.each([false, true])("does not launch a different actor to publish or finish the captured actor's PENDING draft: %s", async (pending) => {
    const f = fixture(); f.update(1); f.configuration.maxAttempts = 2;
    let switched = false;
    const snapshot = f.client.getPullRequestReviewSnapshot;
    f.client.getPullRequestReviewSnapshot = async (...args) => ({ ...await snapshot(...args), viewerId: switched ? "new-reader" : "viewer" });
    f.run(async (review, input) => {
      expect(input.publisherId).toBe("viewer");
      if (review.attemptCount === 1) {
        if (pending) {
          f.publications.push({ id: "actor-a-draft", authorId: "viewer", headSha: review.headSha, state: "PENDING", body: `number=1 fixture\ndaynight review=${review.id} revision=1 head=${review.headSha}` });
          f.threads.push({ id: "actor-a-private", reviewId: "actor-a-draft", isResolved: false }, { id: "foreign", reviewId: "foreign-review", isResolved: false });
        }
        switched = true;
        return false;
      }
      if (pending) f.publications[0]!.state = "COMMENTED";
      return true;
    });
    f.start(); await waitFor(() => f.events.some((event) => event.phase === "publisher"), "captured actor wait");
    const first = f.store.listReviews(f.pr())[0]!;
    const polls = f.polls[0]!; await waitFor(() => f.polls[0]! >= polls + 5, "account wait beyond backoff");
    expect(f.launched).toHaveLength(1); expect(f.prepared).toHaveLength(1);
    expect(f.store.getReview(first.id)).toMatchObject({ status: "retry_wait", attemptCount: 1 });
    switched = false;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "captured actor resumed round");
    expect(f.launched).toHaveLength(2);
    expect(f.launched[1]!.review.id).toBe(first.id);
    expect(f.store.getReviewPublication(first.id)!.publisherId).toBe("viewer");
  });

  it("keeps newly created rounds strict when a legacy-style prefixed approval is returned", async () => {
    const f = fixture(); f.update(1); f.configuration.maxAttempts = 1;
    f.run(async (review, input) => {
      expect(input.publicationIdentityFormat).toBe("line");
      f.publications.push({ id: "wrong-new-format", authorId: "viewer", headSha: review.headSha, state: "APPROVED", body: `number=1 fixture\nStable review identity: daynight review=${review.id} revision=1 head=${review.headSha}` });
      return true;
    });
    f.start(); await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "failed", "strict new-round publication rejection");
    expect(f.store.getPullRequest(f.pr())!.completedRevision).toBe(0);
  });

  it("retains successful last-attempt publication verification across API errors and restart without relaunch", async () => {
    const f = fixture(); f.update(1); f.configuration.maxAttempts = 1;
    let failRead = true;
    f.snapshot(async () => { if (f.launched.length > 0 && failRead) throw new Error("snapshot unavailable"); });
    const first = f.start();
    await waitFor(() => f.events.some((event) => event.phase === "publication"), "read-only verification error");
    const review = f.store.listReviews(f.pr())[0]!;
    expect(review).toMatchObject({ status: "running", attemptCount: 1 });
    expect(f.store.getReviewPublication(review.id)!.phase).toBe("pending");
    first.abort.abort(); await first.completion;
    const recover = vi.fn(async () => proof);
    failRead = false; f.start({ processes: { ...f.processes, recover } });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "read-only restart confirmation");
    expect(f.launched).toHaveLength(1); expect(recover).not.toHaveBeenCalled();
    expect(f.store.getReview(review.id)!.attemptCount).toBe(1);
  });

  it("verifies the captured publisher after the authenticated reader changes", async () => {
    const f = fixture(); f.update(1);
    const snapshot = f.client.getPullRequestReviewSnapshot;
    f.client.getPullRequestReviewSnapshot = async (...args) => {
      const result = await snapshot(...args);
      return { ...result, viewerId: f.launched.length === 0 ? "viewer" : "new-reader" };
    };
    f.start(); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "original publisher confirmation");
    expect(f.store.getReviewPublication(f.launched[0]!.review.id)!.publisherId).toBe("viewer");
    expect(f.launched).toHaveLength(1);
  });

  it("settles an already approved same target after Draft becomes ready without rerunning", async () => {
    const f = fixture(); f.update(1); f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "approval");
    f.update(1, { draft: true }); await waitFor(() => f.store.getPullRequest(f.pr())?.draft === true, "draft observation");
    f.update(1, { draft: false }); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "same-target approval reconciliation");
    expect(f.launched).toHaveLength(1);
    f.update(1, { baseRef: "release" }); await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 3, "different base review");
    expect(f.launched).toHaveLength(2);
  });

  it("reviews a returned historical head again when GitHub has dismissed its cached approval", async () => {
    const f = fixture(); f.update(1); f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "first head approval");
    const first = f.launched[0]!.review;
    const firstPublication = f.store.getReviewPublication(first.id)!;
    f.update(1, { headSha: "e".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "second head approval");
    const historical = f.publications.find((publication) => publication.id === firstPublication.remoteReviewId)!;
    historical.state = "DISMISSED";
    f.update(1, { headSha: first.headSha });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 3, "fresh approval after returning to historical head");
    expect(f.launched.map(({ review }) => review.headSha)).toEqual(["a".repeat(40), "e".repeat(40), "a".repeat(40)]);
    expect(f.launched[2]!.review.id).not.toBe(first.id);
    expect(historical.state).toBe("DISMISSED");
    expect(f.store.getReviewPublication(f.launched[2]!.review.id)!.outcome).toBe("approved");
  });

  it("rejects an empty COMMENT as incomplete rather than claiming completion", async () => {
    const f = fixture(); f.update(1); f.configuration.maxAttempts = 1;
    f.run(async (review) => {
      f.publications.push({ id: "empty-comment", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\ndaynight review=${review.id} revision=1 head=${review.headSha}` });
      return true;
    });
    f.start(); await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "failed", "invalid publication failure");
    expect(f.store.getPullRequest(f.pr())!.completedRevision).toBe(0);
  });

  it("waits for CI without reserving resources and admits other ready PRs before CI finishes", async () => {
    const f = fixture(); f.update(1); f.update(2);
    const firstCheck = deferred<{ headSha: string; baseRef: string; ready: boolean }>();
    let ready = false;
    f.checks(async (pr) => pr.number === 1 && f.checked.filter((item) => item.number === 1).length === 1 ? firstCheck.promise :
      { headSha: pr.headSha, baseRef: pr.baseRef, ready: pr.number === 2 || ready });
    f.start();
    await waitFor(() => f.store.getPullRequest(f.pr(2))?.completedRevision === 1, "other PR during pending CI request");
    expect(f.prepared.map((review) => review.number)).toEqual([2]);
    expect(f.store.listReviews(f.pr(1))).toEqual([]);
    expect(f.store.getPullRequest(f.pr(1))).toMatchObject({ sessionId: null, worktreePath: null, desiredRevision: 1 });
    firstCheck.resolve({ headSha: "a".repeat(40), baseRef: "main", ready: false });
    await waitFor(() => f.checked.filter((item) => item.number === 1).length >= 2, "CI refresh without a new commit");
    expect(f.store.listReviews(f.pr(1))).toEqual([]);
    ready = true;
    await waitFor(() => f.store.getPullRequest(f.pr(1))?.completedRevision === 1, "same target after CI passes");
    expect(f.launched.map((item) => item.review.number)).toEqual([2, 1]);
    expect(f.store.listReviews(f.pr(1))[0]?.attemptCount).toBe(1);
    const checks = f.checked.length;
    const polls = f.polls[0]!;
    await waitFor(() => f.polls[0]! >= polls + 3, "completed review remains suppressed");
    expect(f.checked).toHaveLength(checks);
  });

  it("discards an old CI response when the waiting target advances", async () => {
    const f = fixture(); f.update(1);
    const oldCheck = deferred<{ headSha: string; baseRef: string; ready: boolean }>();
    let ready = false;
    f.checks(async (pr) => pr.headSha === "a".repeat(40) ? oldCheck.promise : { headSha: pr.headSha, baseRef: pr.baseRef, ready });
    f.start();
    await waitFor(() => f.checked.length === 1, "old head check");
    f.update(1, { headSha: "e".repeat(40), baseRef: "release" });
    await waitFor(() => f.checked.some((item) => item.headSha === "e".repeat(40)), "new target CI check while old check remains pending");
    oldCheck.resolve({ headSha: "a".repeat(40), baseRef: "main", ready: true });
    const polls = f.polls[0]!;
    await waitFor(() => f.polls[0]! >= polls + 2, "stale check completion");
    expect(f.prepared).toEqual([]);
    expect(f.store.listReviews(f.pr())).toEqual([]);
    ready = true;
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "new target passing CI");
    expect(f.launched.map((item) => [item.review.headSha, item.review.baseRef])).toEqual([["e".repeat(40), "release"]]);
  });

  it.each([{ draft: true }, { state: "closed" as const }])("ignores CI success after a waiting PR becomes ineligible: %j", async (change) => {
    const f = fixture(); f.update(1);
    const checks = deferred<{ headSha: string; baseRef: string; ready: boolean }>();
    f.checks(async () => checks.promise);
    f.start();
    await waitFor(() => f.checked.length === 1, "pending admission check");
    f.update(1, change);
    await waitFor(() => {
      const pr = f.store.getPullRequest(f.pr());
      return pr?.draft === true || pr?.state === "closed";
    }, "ineligible observation");
    checks.resolve({ headSha: "a".repeat(40), baseRef: "main", ready: true });
    const polls = f.polls[0]!;
    await waitFor(() => f.polls[0]! >= polls + 2, "stale ineligible CI completion");
    expect(f.prepared).toEqual([]);
    expect(f.store.getPullRequest(f.pr())?.sessionId).toBeNull();
  });

  it("revalidates CI after worktree preparation and preserves the review budget after a regression", async () => {
    const f = fixture(); f.update(1);
    const preparation = deferred();
    let ready = true;
    f.checks(async (pr) => ({ headSha: pr.headSha, baseRef: pr.baseRef, ready }));
    f.prepare(async () => { if (f.prepared.length === 1) await preparation.promise; });
    f.start();
    await waitFor(() => f.prepared.length === 1, "initial passing CI reservation");
    const review = f.store.listReviews(f.pr())[0]!;
    const session = f.store.getPullRequest(f.pr())!.sessionId;
    ready = false;
    preparation.resolve();
    await waitFor(() => f.store.getReview(review.id)?.status === "retry_wait", "CI regression before agent launch");
    expect(f.launched).toEqual([]);
    expect(f.store.getReview(review.id)?.attemptCount).toBe(0);
    expect(f.events.some((event) => event.phase === "ci" && event.reviewId === review.id)).toBe(true);
    await waitFor(() => f.checked.length >= 3, "CI admission retry");
    expect(f.prepared).toHaveLength(1);
    ready = true;
    await waitFor(() => f.store.getReview(review.id)?.status === "completed", "passing CI retry");
    expect(f.launched).toHaveLength(1);
    expect(f.launched[0]?.session).toBe(session);
    expect(f.launched[0]?.review.attemptCount).toBe(1);
  });

  it("rereads the captured target after an asynchronous prelaunch CI check", async () => {
    const f = fixture(); f.update(1);
    const prelaunch = deferred<{ headSha: string; baseRef: string; ready: boolean }>();
    f.checks(async (pr) => f.checked.length === 2 ? prelaunch.promise : { headSha: pr.headSha, baseRef: pr.baseRef, ready: true });
    f.start();
    await waitFor(() => f.checked.length === 2, "prelaunch CI query");
    f.update(1, { headSha: "e".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.desiredRevision === 2, "head change during prelaunch check");
    prelaunch.resolve({ headSha: "a".repeat(40), baseRef: "main", ready: true });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "updated target review");
    expect(f.launched.map((item) => item.review.headSha)).toEqual(["e".repeat(40)]);
    expect(f.store.listReviews(f.pr()).map((review) => review.status)).toEqual(["superseded", "completed"]);
  });

  it("honors CI API cooldown without consuming a worker, reservation, or agent attempt", async () => {
    const f = fixture(); f.update(1); f.update(2);
    let clock = Date.now();
    const cooldown = clock + 180;
    f.checks(async (pr) => {
      if (pr.number === 1 && f.checked.filter((item) => item.number === 1).length === 1) throw new GitHubApiError("CI rate limited", { status: 429, retryAt: cooldown });
      return { headSha: pr.headSha, baseRef: pr.baseRef, ready: true };
    });
    f.start({ now: () => clock });
    await waitFor(() => f.store.getPullRequest(f.pr(2))?.completedRevision === 1, "ready PR during CI cooldown");
    expect(f.checked.filter((item) => item.number === 1)).toHaveLength(1);
    expect(f.store.listReviews(f.pr(1))).toEqual([]);
    expect(f.store.getPullRequest(f.pr(1))).toMatchObject({ sessionId: null, worktreePath: null });
    expect(f.events.find((event) => event.phase === "ci" && event.level === "error")?.retryAt).toBe(cooldown);
    clock = cooldown - 1;
    await waitFor(() => f.store.getRepository(f.identities[0]!)?.lastPollAt === clock, "completed scan before CI cooldown expiry");
    expect(f.checked.filter((item) => item.number === 1)).toHaveLength(1);
    expect(f.store.listReviews(f.pr(1))).toEqual([]);
    expect(f.prepared.map((review) => review.number)).toEqual([2]);
    expect(f.launched.map((item) => item.review.number)).toEqual([2]);
    expect(f.store.getPullRequest(f.pr(1))).toMatchObject({ sessionId: null, worktreePath: null });
    clock = cooldown;
    await waitFor(() => f.store.getPullRequest(f.pr(1))?.completedRevision === 1, "CI cooldown expiry");
    expect(f.launched.map((item) => item.review.number)).toEqual([2, 1]);
    expect(f.store.listReviews(f.pr(1))[0]).toMatchObject({ attemptCount: 1, createdAt: cooldown });
  });

  it("defers prelaunch CI API errors through their cooldown without spending an attempt", async () => {
    const f = fixture(); f.update(1); f.update(2);
    let clock = Date.now();
    const cooldown = clock + 160;
    f.checks(async (pr) => {
      if (pr.number === 1 && f.checked.filter((item) => item.number === 1).length === 2) {
        throw new GitHubApiError("prelaunch CI rate limited", { status: 429, retryAt: cooldown });
      }
      return { headSha: pr.headSha, baseRef: pr.baseRef, ready: true };
    });
    f.start({ now: () => clock });
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "retry_wait", "prelaunch CI API deferral");
    const review = f.store.listReviews(f.pr())[0]!;
    const captured = f.store.getPullRequest(f.pr())!;
    expect(review.attemptCount).toBe(0);
    expect(review.retryAt).toBe(cooldown);
    expect(f.launched.filter((item) => item.review.number === 1)).toEqual([]);
    expect(captured.sessionId).not.toBeNull();
    expect(captured.worktreePath).not.toBeNull();
    await waitFor(() => f.store.getPullRequest(f.pr(2))?.completedRevision === 1, "other PR after prelaunch deferral releases its worker");
    clock = cooldown - 1;
    await waitFor(() => f.store.getRepository(f.identities[0]!)?.lastPollAt === clock, "completed scan before prelaunch cooldown expiry");
    expect(f.checked.filter((item) => item.number === 1)).toHaveLength(2);
    expect(f.store.getReview(review.id)).toMatchObject({ status: "retry_wait", attemptCount: 0, retryAt: cooldown });
    expect(f.prepared.filter((item) => item.number === 1)).toHaveLength(1);
    expect(f.launched.map((item) => item.review.number)).toEqual([2]);
    clock = cooldown;
    await waitFor(() => f.store.getReview(review.id)?.status === "completed", "CI API recovery");
    const launched = f.launched.find((item) => item.review.number === 1)!;
    expect(launched.review).toMatchObject({ id: review.id, headSha: review.headSha, baseRef: review.baseRef, attemptCount: 1 });
    expect(launched.session).toBe(captured.sessionId);
    expect(f.store.getPullRequest(f.pr())).toMatchObject({ sessionId: captured.sessionId, worktreePath: captured.worktreePath });
    expect(f.store.listReviews(f.pr())).toHaveLength(1);
    expect(f.events.find((event) => event.phase === "launch" && event.reviewId === review.id)?.attempt).toBe(0);
    expect(f.prepared.filter((item) => item.number === 1).map((item) => item.id)).toEqual([review.id, review.id]);
  });

  it("gates an incomplete agent retry on CI while reusing its persisted review and session", async () => {
    const f = fixture(); f.update(1);
    let ready = true;
    f.checks(async (pr) => ({ headSha: pr.headSha, baseRef: pr.baseRef, ready }));
    f.run(async () => { if (f.launched.length === 1) { ready = false; return false; } return true; });
    f.start();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "retry_wait" && f.checked.length >= 3, "incomplete attempt waiting for CI");
    const review = f.store.listReviews(f.pr())[0]!;
    expect(f.launched).toHaveLength(1);
    expect(f.prepared).toHaveLength(1);
    expect(review.attemptCount).toBe(1);
    ready = true;
    await waitFor(() => f.store.getReview(review.id)?.status === "completed", "same session retry after CI passes");
    expect(f.launched.map((item) => item.review.id)).toEqual([review.id, review.id]);
    expect(f.launched[1]?.session).toBe(f.launched[0]?.session);
    expect(f.launched[1]?.review.attemptCount).toBe(2);
  });

  it("aborts and awaits a pending CI query before releasing coordinator ownership", async () => {
    const f = fixture(); f.update(1);
    const released = deferred();
    let cancelled = false;
    f.checks(async (_pr, signal) => {
      try { return await untilAborted(signal); }
      finally { cancelled = true; await released.promise; }
    });
    const run = f.start();
    await waitFor(() => f.checked.length === 1, "pending CI query");
    run.abort.abort();
    await waitFor(() => cancelled, "CI cancellation");
    let returned = false; void run.completion.then(() => { returned = true; });
    expect(returned).toBe(false);
    expect(f.prepared).toEqual([]);
    released.resolve();
    await expect(run.completion).resolves.toEqual({ safeToReleaseLock: true });
  });

  it("initializes a permanent all-state cutoff before admitting later PRs", async () => {
    const f = fixture(1, false);
    f.client.listPullRequestNumbers = async () => [2, 9, 4];
    f.update(2); f.update(9); f.update(10);
    f.start();
    await waitFor(() => f.store.getPullRequest(f.pr(10))?.completedRevision === 1, "post-cutoff PR review");
    expect(f.store.getRepository(f.identities[0]!)?.startPrNumber).toBe(9);
    expect(f.store.getPullRequest(f.pr(2))).toBeNull();
    expect(f.store.getPullRequest(f.pr(9))).toBeNull();
    f.update(9, { headSha: "e".repeat(40), baseRef: "release" });
    const polls = f.polls[0]!;
    await waitFor(() => f.polls[0]! > polls + 1, "permanent cutoff scans");
    expect(f.launched.map((item) => item.review.number)).toEqual([10]);
    expect(f.events.some((event) => event.phase === "initialize" && event.message.includes("9"))).toBe(true);
  });

  it("reserves a PR before asynchronous preparation and holds the global slot through execution", async () => {
    const f = fixture();
    f.update(1); f.update(2);
    const prepare = deferred(); const execute = deferred<boolean>();
    f.prepare(async (review) => { if (review.number === 1) await prepare.promise; });
    f.run(async (review) => review.number === 1 ? execute.promise : true);
    f.start();
    await waitFor(() => f.prepared.length === 1 && f.polls[0]! >= 3, "polling during preparation");
    expect(f.store.listActiveReviews()).toHaveLength(1);
    expect(f.store.listActiveReviews()[0]?.status).toBe("preparing");
    expect(f.prepared.map((item) => item.number)).toEqual([1]);
    prepare.resolve();
    await waitFor(() => f.launched.length === 1 && f.polls[0]! >= 5, "polling during execution");
    expect(f.prepared).toHaveLength(1);
    execute.resolve(true);
    await waitFor(() => f.store.getPullRequest(f.pr(2))?.completedRevision === 1, "second PR after the first slot releases");
    expect(f.prepared.map((item) => item.number)).toEqual([1, 2]);
  });

  it("polls repositories independently while agents and another repository scan are delayed", async () => {
    const f = fixture(2); f.configuration.maxConcurrentWorker = 2;
    f.update(1, {}, 0); f.update(1, {}, 1);
    const scan = deferred(); const agent = deferred<boolean>();
    f.poll(async (index) => { if (index === 0) await scan.promise; });
    f.run(async () => agent.promise);
    f.start();
    await waitFor(() => f.polls[1]! >= 4 && f.launched.length === 1, "unblocked repository polling and review");
    expect(f.polls[0]).toBe(1);
    expect(f.launched[0]?.review.githubId).toBe(f.identities[1]!.githubId);
    scan.resolve(); agent.resolve(true);
    await waitFor(() => f.launched.length === 2 && f.store.listActiveReviews().length === 0, "both repository reviews");
  });

  it.each([[2, 3], [3, 2]])("admits waiting PRs before a continuously advancing PR's next revision (CI response order %i, %i)", async (firstReady, secondReady) => {
    const f = fixture(2);
    f.update(1); f.update(2); f.update(3, {}, 1);
    const checks = new Map([2, 3].map((number) => [number, deferred<Awaited<ReturnType<GitHubClient["getPullRequestChecks"]>>>()]));
    const executions = Array.from({ length: 4 }, () => deferred<boolean>());
    const passing = { headSha: "a".repeat(40), baseRef: "main", ready: true };
    f.checks(async (pr) => {
      if (pr.number !== 1 && f.checked.filter((item) => item.number === pr.number).length === 1) return checks.get(pr.number)!.promise;
      return { headSha: pr.headSha, baseRef: pr.baseRef, ready: true };
    });
    let revision = 10;
    f.run(async (review) => {
      if (review.number === 1) f.update(1, { headSha: (++revision).toString(16).padStart(40, "0") });
      return executions[f.launched.length - 1]!.promise;
    });
    let clock = Date.now();
    const run = f.start({ now: () => clock });
    try {
      await waitFor(() => f.launched.length === 1, "first hot PR execution");
      expect(f.launched[0]?.review.number).toBe(1);
      clock += f.configuration.pollIntervalMs;
      await waitFor(() => f.store.getPullRequest(f.pr(1))?.desiredRevision === 2, "hot successor observed before releasing its worker");
      for (const number of [firstReady, secondReady]) {
        checks.get(number)!.resolve(passing);
        await waitFor(() => f.events.some((event) => event.phase === "ci" && event.number === number && event.message === "All CI checks passed for the waiting PR target."), `PR ${number} admission ready`);
      }
      for (const [index, number] of [2, 3, 1].entries()) {
        executions[index]!.resolve(true);
        await waitFor(() => f.launched.length === index + 2, `PR ${number} execution after releasing the previous worker`);
        expect(f.launched[index + 1]?.review.number).toBe(number);
      }
      expect(f.launched.map((item) => [item.review.number, item.review.revision, item.review.headSha])).toEqual([
        [1, 1, "a".repeat(40)], [2, 1, "a".repeat(40)], [3, 1, "a".repeat(40)], [1, 2, "b".padStart(40, "0")],
      ]);
      expect(f.store.getPullRequest(f.pr(1))?.completedRevision).toBe(1);
      expect(f.store.getPullRequest(f.pr(2))?.completedRevision).toBe(1);
      expect(f.store.getPullRequest(f.pr(3, 1))?.completedRevision).toBe(1);
    } finally {
      run.abort.abort();
      for (const check of checks.values()) check.resolve(passing);
      for (const execution of executions) execution.resolve(true);
      await run.completion;
    }
  });

  it("lets timers progress when every immediately completed poll is already due again", async () => {
    const f = fixture(); f.configuration.pollIntervalMs = 2;
    let timerFired = false;
    let timerProgressAtCap = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    f.poll(async () => {
      if (f.polls[0] === 64) {
        timerProgressAtCap = timerFired;
        f.runs[0]!.abort.abort();
      }
    });
    let clock = Date.now();
    const run = f.start({ now: () => clock += 5 });
    try {
      await run.completion;
      expect(f.polls[0]).toBe(64);
      expect(timerProgressAtCap).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("cancels an in-flight poll after an internal fatal error without requiring an external abort", async () => {
    const f = fixture(2);
    const originalCandidates = f.store.listCandidates;
    const originalPoll = f.client.listOpenPullRequests;
    let polling = false;
    let pollStopped = false;
    let pollSignal: AbortSignal | undefined;
    f.client.listOpenPullRequests = async (repository, cutoff, signal) => {
      if (repository.githubId !== f.identities[0]!.githubId) return originalPoll(repository, cutoff, signal);
      polling = true; pollSignal = signal;
      try { return await untilAborted(signal!); }
      finally { pollStopped = true; }
    };
    f.store.listCandidates = (time) => {
      if (polling) throw new Error("SQLite selection failed.");
      return originalCandidates(time);
    };
    const run = f.start();
    const observed = run.completion.catch((error: unknown) => error);
    await waitFor(() => pollStopped, "fatal failure cancelling pending polling");
    expect(pollSignal?.aborted).toBe(true);
    expect(run.abort.signal.aborted).toBe(false);
    await expect(observed).resolves.toMatchObject({ message: "SQLite selection failed." });
    f.runs.splice(f.runs.indexOf(run), 1);
    f.store.listCandidates = originalCandidates;
    f.client.listOpenPullRequests = originalPoll;
  });

  it("coalesces head advances without cancelling a running captured revision or consuming its successor", async () => {
    const f = fixture(); f.update(1);
    const first = deferred<boolean>(); const second = deferred<boolean>();
    f.run(async (_review, _input) => f.launched.length === 1 ? first.promise : second.promise);
    f.start();
    await waitFor(() => f.launched.length === 1, "first captured target");
    f.update(1, { headSha: "d".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.desiredRevision === 2, "first newer head");
    f.update(1, { headSha: "e".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.desiredRevision === 3, "latest newer head");
    expect(f.launched[0]?.input.signal?.aborted).toBe(false);
    first.resolve(true);
    await waitFor(() => f.launched.length === 2, "coalesced latest target");
    expect(f.launched.map((item) => item.review.headSha)).toEqual(["a".repeat(40), "e".repeat(40)]);
    expect(f.launched[1]?.session).toBe(f.launched[0]?.session);
    expect(f.store.getPullRequest(f.pr())?.completedRevision).toBe(1);
    second.resolve(true);
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 3, "newest completion");
    f.update(1, { baseSha: "f".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.baseSha === "f".repeat(40), "base tip observation");
    expect(f.launched).toHaveLength(2);
  });

  it("rechecks the target after preparation and launches only the latest ready target", async () => {
    const f = fixture(); f.update(1);
    const preparation = deferred();
    f.prepare(async () => { if (f.prepared.length === 1) await preparation.promise; });
    f.start();
    await waitFor(() => f.prepared.length === 1, "initial reservation");
    f.update(1, { baseRef: "release" });
    await waitFor(() => f.store.getPullRequest(f.pr())?.baseRef === "release", "changed target branch");
    preparation.resolve();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "new target branch review");
    expect(f.launched).toHaveLength(1);
    expect(f.launched[0]?.review.baseRef).toBe("release");
    expect(f.store.listReviews(f.pr()).map((item) => item.status).sort()).toEqual(["completed", "superseded"]);
    expect(f.launched[0]?.input.previousReview?.baseRef).toBe("main");
  });

  it("persists failed suppression across restart and grants a new budget only for a new trigger", async () => {
    const f = fixture(); f.configuration.maxAttempts = 2; f.update(1);
    f.run(async (review) => review.revision !== 1);
    const first = f.start();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "failed", "exhausted attempt budget");
    expect(f.launched).toHaveLength(2);
    expect(new Set(f.launched.map((item) => item.review.id)).size).toBe(1);
    expect(f.launched.map((item) => item.review.attemptCount)).toEqual([1, 2]);
    first.abort.abort(); await first.completion;
    const second = f.start();
    const previousPolls = f.polls[0]!;
    await waitFor(() => f.polls[0]! >= previousPolls + 3, "restart scans");
    expect(f.launched).toHaveLength(2);
    f.update(1, { headSha: "e".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "new revision budget");
    expect(f.launched).toHaveLength(3);
    expect(f.launched[2]?.review.attemptCount).toBe(1);
    expect(f.launched[2]?.session).toBe(f.launched[0]?.session);
    expect(f.launched[2]?.input.previousReview?.id).toBe(f.launched[0]?.review.id);
    second.abort.abort();
  });

  it("persists exponential agent retry deadlines with a ten minute cap", async () => {
    const f = fixture(); f.configuration.retryDelayMs = 400_000; f.update(1);
    f.store.observePullRequest(f.identities[0]!, observation(1), 1);
    const review = f.store.reserveReview(f.pr(), { reviewId: uuid(1), sessionId: uuid(2), maxAttempts: 3 }, 1)!;
    f.store.registerWorktree(f.pr(), path.join(f.configurations[0]!.path, ".worktrees", "pr-1"));
    f.store.pinReviewBase(review.id, "b".repeat(40), 1);
    f.store.startAttempt(review.id, { processOwner: "prior", stdoutLogPath: "out", stderrLogPath: "err" }, 1);
    f.store.retryReview({ reviewId: review.id, attempt: 1 }, proof, { error: "previous incomplete", retryAt: 1 }, 1);
    f.run(async () => false);
    f.start();
    await waitFor(() => f.store.getReview(review.id)?.attemptCount === 2 && f.store.getReview(review.id)?.status === "retry_wait", "capped retry deadline");
    const retry = f.store.getReview(review.id)!;
    expect(retry.retryAt! - retry.updatedAt).toBe(600_000);
    expect(f.launched[0]?.review.id).toBe(review.id);
  });

  it("cancels observed Draft and closed PRs and serializes cleanup with reopening", async () => {
    const f = fixture(); f.update(1);
    f.run(async (_review, input) => untilAborted(input.signal!));
    let excludeCalls = 0;
    const exclusion = deferred();
    f.processes.exclude = async () => { excludeCalls++; if (excludeCalls === 2) await exclusion.promise; return proof; };
    const cleaning = deferred(); f.cleanup(async () => cleaning.promise);
    f.start();
    await waitFor(() => f.launched.length === 1, "first ready review");
    f.update(1, { draft: true });
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "superseded", "Draft cancellation");
    expect(f.cleaned).toHaveLength(0);
    f.update(1, { draft: false });
    await waitFor(() => f.launched.length === 2, "Draft to ready review");
    f.update(1, { state: "closed" });
    await waitFor(() => excludeCalls === 2, "closed agent process exclusion");
    expect(f.cleaned).toHaveLength(0);
    exclusion.resolve();
    await waitFor(() => f.cleaned.length === 1, "serialized cleanup");
    f.update(1, { state: "open" });
    await waitFor(() => f.store.getPullRequest(f.pr())?.state === "open", "reopening during cleanup");
    expect(f.launched).toHaveLength(2);
    cleaning.resolve();
    await waitFor(() => f.launched.length === 3, "reopened review after cleanup release");
    expect(f.launched[2]?.session).toBe(f.launched[0]?.session);
  });

  it("does not complete an otherwise successful marker before process exclusion succeeds", async () => {
    const f = fixture(); f.update(1);
    const exclusion = deferred();
    f.processes.exclude = async () => { await exclusion.promise; throw new Error("A child remains live."); };
    const run = f.start();
    await waitFor(() => f.launched.length === 1, "completed direct agent");
    expect(f.store.getPullRequest(f.pr())?.completedRevision).toBe(0);
    exclusion.resolve();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "interrupted", "uncertain exclusion state");
    f.update(1, { headSha: "d".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.desiredRevision === 2, "later target under uncertainty");
    expect(f.launched).toHaveLength(1);
    run.abort.abort();
    await expect(run.completion).resolves.toEqual({ safeToReleaseLock: false });
  });

  it("retains a failed discovery exclusion without retrying exclusion or launching another attempt", async () => {
    const f = fixture(); f.update(1);
    const exclusionError = new Error("Discovery execution remains uncertain.");
    const original = f.runner.run;
    const exclude = vi.spyOn(f.processes, "exclude");
    const runner: CoordinatorOptions["runner"] = { run: async (...args) => {
      const outcome = await original(...args);
      f.store.recordProcess(outcome.attempt, { pid: 12345, identity: "discovery" });
      return { ...outcome, completed: false, processExclusionFailure: exclusionError, errors: [exclusionError] };
    } };
    const run = f.start({ runner });
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "interrupted", "retained discovery exclusion failure");
    expect(exclude).not.toHaveBeenCalled();
    expect(f.store.listReviews(f.pr())[0]).toMatchObject({ attemptCount: 1, processId: 12345, processIdentity: "discovery", lastError: exclusionError.message });
    f.update(1, { headSha: "d".repeat(40) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.desiredRevision === 2, "later target under discovery uncertainty");
    expect(f.launched).toHaveLength(1);
    run.abort.abort();
    await expect(run.completion).resolves.toEqual({ safeToReleaseLock: false });
  });

  it("recovers old execution only after explicit proof and uses one advancing-clock recovery timestamp", async () => {
    const f = fixture(); f.update(1);
    f.store.observePullRequest(f.identities[0]!, observation(1), 1);
    const review = f.store.reserveReview(f.pr(), { reviewId: uuid(1), sessionId: uuid(2), maxAttempts: 3 }, 1)!;
    f.store.registerWorktree(f.pr(), path.join(f.configurations[0]!.path, ".worktrees", "pr-1"));
    f.store.pinReviewBase(review.id, "b".repeat(40), 1);
    f.store.startAttempt(review.id, { processOwner: "old", stdoutLogPath: "old-out", stderrLogPath: "old-err" }, 1);
    f.store.recordProcess({ reviewId: review.id, attempt: 1 }, { pid: 1234, identity: "old:1" });
    const recovery = deferred();
    f.processes.recover = async () => { await recovery.promise; return proof; };
    let time = Date.now();
    f.start({ now: () => ++time });
    await waitFor(() => f.store.getReview(review.id)?.status === "interrupted", "persisted uncertainty before proof");
    expect(f.launched).toHaveLength(0);
    recovery.resolve();
    await waitFor(() => f.store.getReview(review.id)?.status === "completed", "recovered target confirmation");
    expect(f.launched[0]?.review.id).toBe(review.id);
    expect(f.launched[0]?.review.attemptCount).toBe(2);
    expect(f.events.some((event) => event.phase === "recovery")).toBe(true);
  });

  it("retains a startup preparation whose process and operation exclusion cannot be confirmed", async () => {
    const f = fixture(); f.update(1);
    f.store.observePullRequest(f.identities[0]!, observation(1), 1);
    const old = f.store.reserveReview(f.pr(), { reviewId: uuid(1), sessionId: uuid(2), maxAttempts: 3 }, 1)!;
    f.processes.recover = async () => { throw new Error("Operator recovery proof is missing."); };
    const run = f.start();
    await waitFor(() => f.polls[0]! >= 3, "polls around blocked recovery");
    expect(f.store.getReview(old.id)?.status).toBe("interrupted");
    expect(f.launched).toHaveLength(0);
    expect(f.prepared).toHaveLength(0);
    run.abort.abort(); await expect(run.completion).resolves.toEqual({ safeToReleaseLock: false });
  });

  it("keeps failed cleanup pending and retries it while admitting reviews for other PRs", async () => {
    const f = fixture(); f.update(1);
    let failed = false;
    f.cleanup(async () => {
      if (!failed) {
        failed = true;
        const pr = f.store.getPullRequest(f.pr())!;
        f.store.recordCleanupError(pr, pr.worktreePath!, "sharing violation");
        throw new Error("sharing violation");
      }
    });
    f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "review before closure");
    f.update(1, { state: "closed" }); f.update(2);
    await waitFor(() => f.events.some((event) => event.phase === "cleanup" && event.level === "error"), "persisted cleanup failure");
    await waitFor(() => f.store.getPullRequest(f.pr())?.worktreePath === null && f.store.getPullRequest(f.pr(2))?.completedRevision === 1, "cleanup retry and independent review");
    expect(f.cleaned).toEqual([1, 1]);
    expect(f.store.getPullRequest(f.pr())?.cleanupError).toBeNull();
  });

  it("preserves old cleanup across unconfirmed restarts and reopening while other repositories run", async () => {
    const f = fixture(2);
    f.store.observePullRequest(f.identities[0]!, observation(1), 1);
    f.store.registerWorktree(f.pr(), path.join(f.configurations[0]!.path, ".worktrees", "pr-1"));
    f.store.observePullRequest(f.identities[0]!, observation(1, { state: "closed" }), 2);
    f.update(1);
    f.update(3);
    f.update(2, {}, 1);
    f.processes.recover = async () => { throw new Error("Old cleanup processes have not been excluded."); };
    const first = f.start();
    await waitFor(() => f.store.getPullRequest(f.pr(2, 1))?.completedRevision === 1, "independent repository review");
    await waitFor(() => f.store.getPullRequest(f.pr(3))?.completedRevision === 1, "independent PR in the same repository");
    expect(f.polls[0]).toBeGreaterThan(0);
    expect(f.cleaned).toEqual([]);
    expect(f.store.getPullRequest(f.pr())?.cleanupPending).toBe(true);
    expect(f.store.getPullRequest(f.pr())?.state).toBe("open");
    first.abort.abort();
    await expect(first.completion).resolves.toEqual({ safeToReleaseLock: false });

    const second = f.start();
    const previousPolls = f.polls[1]!;
    await waitFor(() => f.polls[1]! > previousPolls + 1, "polling during another unconfirmed restart");
    expect(f.prepared.map((review) => review.number).sort()).toEqual([2, 3]);
    expect(f.store.getPullRequest(f.pr())?.cleanupPending).toBe(true);
    second.abort.abort();
    await expect(second.completion).resolves.toEqual({ safeToReleaseLock: false });

    f.processes.recover = async () => proof;
    const confirmed = f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "reopened PR after explicit recovery proof");
    expect(f.cleaned).toEqual([1]);
    confirmed.abort.abort();
    await expect(confirmed.completion).resolves.toEqual({ safeToReleaseLock: true });
  });

  it("defers an ordinary preparation failure without spending an attempt, but blocks uncertain Git execution", async () => {
    const f = fixture(); f.update(1); f.update(2);
    let first = true;
    f.prepare(async (review) => {
      if (review.number === 2) throw new GitCommandError("Command outcome uncertain.", new Error("timeout"), false);
      if (first) { first = false; throw new Error("ordinary preparation failure"); }
    });
    const run = f.start();
    await waitFor(() => f.store.listReviews(f.pr(1))[0]?.status === "completed" && f.store.listReviews(f.pr(2))[0]?.status === "interrupted", "preparation outcomes");
    expect(f.store.listReviews(f.pr(1))[0]?.attemptCount).toBe(1);
    expect(f.prepared.filter((review) => review.number === 1)).toHaveLength(2);
    expect(f.launched.map((item) => item.review.number)).toEqual([1]);
    expect(f.store.listReviews(f.pr(2))[0]?.attemptCount).toBe(0);
    run.abort.abort(); await expect(run.completion).resolves.toEqual({ safeToReleaseLock: false });
  });

  it("waits for shutdown cancellation and process exclusion before returning", async () => {
    const f = fixture(); f.update(1);
    f.run(async (_review, input) => untilAborted(input.signal!));
    const exclusion = deferred(); let excluding = false;
    f.processes.exclude = async () => { excluding = true; await exclusion.promise; return proof; };
    const run = f.start();
    await waitFor(() => f.launched.length === 1, "running agent");
    run.abort.abort(new Error("shutdown"));
    await waitFor(() => excluding, "shutdown process exclusion");
    let returned = false; void run.completion.then(() => { returned = true; });
    expect(returned).toBe(false);
    expect(f.store.listReviews(f.pr())[0]?.status).toBe("running");
    exclusion.resolve();
    await expect(run.completion).resolves.toEqual({ safeToReleaseLock: true });
    expect(f.store.listReviews(f.pr())[0]?.status).toBe("retry_wait");
  });

  it("rejects duplicate stable GitHub identities before rebinding durable local state", async () => {
    const f = fixture(2);
    const originalEnsure = f.git.ensureRepository;
    f.git.ensureRepository = async (config, signal) => {
      const local = await originalEnsure(config, signal);
      return { ...local, repository: { ...local.repository, githubId: "42" } };
    };
    f.start();
    await waitFor(() => f.events.some((event) => event.level === "error" && String(event.error).includes("same GitHub repository")), "duplicate stable identity error");
    expect(f.store.getRepository(f.identities[0]!)?.localPath).toBe(f.configurations[0]!.path);
    expect(f.polls[1]).toBe(0);
  });

  it("honors repository API cooldown without blocking another host or admitting partial observations", async () => {
    const f = fixture(2, true, (index) => index === 0 ? "github.com" : "github.example.com");
    let clock = Date.now();
    const initial = clock;
    const cooldown = clock + 150;
    f.store.observePullRequest(f.identities[0]!, observation(1, { draft: true }), clock);
    const previous = f.store.getPullRequest(f.pr())!;
    const repository = f.store.getRepository(f.identities[0]!)!;
    f.update(1, { state: "closed", draft: true });
    f.update(2, { draft: true });
    f.update(3, {}, 1);
    const list = f.client.listOpenPullRequests;
    let completedList: number[] | undefined;
    f.client.listOpenPullRequests = async (identity, cutoff, signal) => {
      const observations = await list(identity, cutoff, signal);
      if (identity.githubId === f.identities[0]!.githubId) completedList = observations.map((item) => item.number);
      return observations;
    };
    const get = f.client.getPullRequest;
    let first = true;
    f.client.getPullRequest = async (identity, number, signal) => {
      if (identity.githubId === f.identities[0]!.githubId && number === 1 && first) {
        first = false;
        expect(completedList).toEqual([2]);
        throw new GitHubApiError("rate limited", { status: 429, retryAt: cooldown });
      }
      return get(identity, number, signal);
    };
    f.start({ now: () => clock });
    await waitFor(() => f.events.some((event) => event.phase === "poll" && event.retryAt === cooldown), "persisted partial observation failure");
    await waitFor(() => f.store.getPullRequest(f.pr(3, 1))?.completedRevision === 1, "other host review during repository cooldown");
    expect(f.identities[1]!.host).not.toBe(f.identities[0]!.host);
    for (const time of [initial + 20, initial + 40, cooldown - 1]) {
      clock = time;
      await waitFor(() => f.store.getRepository(f.identities[1]!)?.lastPollAt === clock, "completed other-host scan during cooldown");
    }
    expect(f.polls[1]).toBeGreaterThanOrEqual(4);
    expect(f.polls[0]).toBe(1);
    expect(f.store.getPullRequest(f.pr())).toEqual(previous);
    expect(f.store.getPullRequest(f.pr(2))).toBeNull();
    expect(f.store.getRepository(f.identities[0]!)).toMatchObject({ lastPollAt: repository.lastPollAt, lastPollError: "rate limited" });
    expect(f.store.listReviews(f.pr())).toEqual([]);
    expect(f.store.listReviews(f.pr(2))).toEqual([]);
    expect(f.launched.map((item) => item.review.number)).toEqual([3]);
    clock = cooldown;
    await waitFor(() => f.store.getRepository(f.identities[0]!)?.lastPollAt === cooldown, "complete snapshot at repository cooldown expiry");
    expect(f.polls[0]).toBe(2);
    expect(f.store.getPullRequest(f.pr())).toMatchObject({ state: "closed", observedAt: cooldown });
    expect(f.store.getPullRequest(f.pr(2))).toMatchObject({ state: "open", draft: true, observedAt: cooldown });
    expect(f.store.getRepository(f.identities[0]!)?.lastPollError).toBeNull();
    expect(f.launched.map((item) => item.review.number)).toEqual([3]);
  });
});

const nativeGit = (directory: string, args: string[], input?: string): string => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", timeout: 20_000, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
  ...(input === undefined ? {} : { input }), stdio: ["pipe", "pipe", "pipe"],
}).trim();
const commit = (directory: string, value: string, parent?: string): string => {
  const blob = nativeGit(directory, ["hash-object", "-w", "--stdin"], value);
  const attributes = nativeGit(directory, ["hash-object", "-w", "--stdin"], "* -text\n");
  const tree = nativeGit(directory, ["mktree"], `100644 blob ${attributes}\t.gitattributes\n100644 blob ${blob}\tfile.txt\n`);
  return nativeGit(directory, ["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\n${parent === undefined ? "" : `parent ${parent}\n`}author Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nfixture\n`);
};

describe("coordinator real Git, SQLite and controlled agent lifecycle", () => {
  it("clones, reviews exact worktree revisions in one session, and cleans the closed PR", async () => {
    const f = fixture(); f.configuration.pollIntervalMs = 30;
    const upstream = path.join(f.directory, "source.git"); mkdirSync(upstream);
    nativeGit(upstream, ["init", "--bare", "--initial-branch=main"]);
    const base = commit(upstream, "base\n"); const first = commit(upstream, "first PR\n", base); const second = commit(upstream, "second PR\n", first);
    nativeGit(upstream, ["update-ref", "refs/heads/main", base]); nativeGit(upstream, ["update-ref", "refs/pull/1/head", first]);
    f.update(1, { headSha: first, baseSha: base });
    const git = createGitManager({ temporaryDirectory: f.paths.temporaryDirectory, client: f.client, execute: async (file, args, options) => {
      if (file === "gh") return { stdout: "fixture-only-secret\n", stderr: "", error: null };
      return executeCommand(file, ["-c", "protocol.file.allow=always", "-c", `url.${pathToFileURL(upstream).href}.insteadOf=${f.configurations[0]!.remote}`, ...args], options);
    } });
    const report = path.join(f.directory, "agent-report.jsonl"); const script = path.join(f.directory, "review-agent.mjs");
    writeFileSync(script, `import path from 'node:path';import{mkdirSync,writeFileSync,appendFileSync,readFileSync}from'node:fs';import{execFileSync}from'node:child_process';
let prompt='';for await(const part of process.stdin)prompt+=part;const args=process.argv.slice(2);if(args.includes('skill')&&args.includes('list')){process.stdout.write(JSON.stringify([{name:'daynight-review',enabled:true,source:'plugin',path:path.join(args.find(arg=>arg.startsWith('--plugin-dir=')).slice('--plugin-dir='.length),'skills','daynight-review')}]));process.exit(0);}const option=args.find(x=>x.startsWith('--session-id=')||x.startsWith('--resume='));const session=option.split('=')[1];
mkdirSync(path.join(process.env.COPILOT_HOME,'session-state',session),{recursive:true});writeFileSync(path.join(process.env.COPILOT_HOME,'session-state',session,'opaque.jsonl'),'opaque');
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();appendFileSync(process.env.FIXTURE_REPORT,JSON.stringify({session,option,sha,contents:readFileSync('file.txt','utf8'),prompt})+'\\n');process.stdout.write('PR 1 Review Completed\\n');`);
    const skillDirectory = path.join(f.directory, "plugin, skill", "skills", "daynight-review"); mkdirSync(skillDirectory, { recursive: true });
    const runner = createCopilotRunner({ skill: { name: "daynight-review", digest: "a".repeat(64), rootDirectory: path.dirname(path.dirname(skillDirectory)), directory: skillDirectory, entrypoint: path.join(skillDirectory, "SKILL.md") }, paths: f.paths, processOwner: uuid(900), timeoutMs: 10_000, terminationGraceMs: 100,
      command: { file: process.execPath, args: [script] }, environment: { ...process.env, FIXTURE_REPORT: report } });
    const publishingRunner: CoordinatorOptions["runner"] = { run: async (...args) => {
      const outcome = await runner.run(...args);
      const review = args[0].getReview(args[1])!;
      if (outcome.completed) f.publications.push({ id: `remote-${review.id}`, authorId: "viewer", headSha: review.headSha, state: "APPROVED",
        body: `number=${review.number} fixture\n<!-- daynight review=${review.id} revision=${review.revision} head=${review.headSha} -->` });
      return outcome;
    } };
    f.start({ git, runner: publishingRunner, processes: createProcessSupervisor({ graceMs: 500, previousProcessesExcluded: true }) });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "first real review", 30_000);
    const target = path.join(f.configurations[0]!.path, ".worktrees", "pr-1");
    expect(nativeGit(target, ["rev-parse", "HEAD"])).toBe(first);
    writeFileSync(path.join(target, "generated.txt"), "discarded on next revision");
    nativeGit(upstream, ["update-ref", "refs/pull/1/head", second]); f.update(1, { headSha: second });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "second real review", 30_000);
    const reports = readFileSync(report, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { session: string; option: string; sha: string; contents: string; prompt: string });
    expect(reports.map((item) => item.sha)).toEqual([first, second]);
    expect(reports.map((item) => item.contents)).toEqual(["first PR\n", "second PR\n"]);
    expect(reports[1]?.session).toBe(reports[0]?.session);
    expect(reports[0]?.option).toMatch(/^--session-id=/); expect(reports[1]?.option).toMatch(/^--resume=/);
    expect(existsSync(path.join(target, "generated.txt"))).toBe(false);
    expect(nativeGit(f.configurations[0]!.path, ["rev-parse", "HEAD"])).toBe(base);
    f.update(1, { state: "merged" });
    await waitFor(() => f.store.getPullRequest(f.pr())?.worktreePath === null, "real worktree cleanup", 30_000);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(f.paths.copilotDirectory, "session-state", reports[0]!.session))).toBe(true);
    expect(f.events.filter((event) => event.phase === "completed")).toHaveLength(2);
  }, 90_000);
});
