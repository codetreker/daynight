import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitCommandError } from "../../../src/commands/review/adapters/worktrees.js";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";
import { openStore } from "../../../src/commands/review/store.js";

import { createCoordinatorFixtures } from "./coordinator-fixtures.js";

const { proof, uuid, deferred, waitFor, observation, fixture } = createCoordinatorFixtures(false);

describe("foreground review coordination", () => {
  it.each([
    ["running", "APPROVED"], ["retry_wait", "APPROVED"], ["running", "COMMENTED"], ["retry_wait", "COMMENTED"],
  ] as const)("recovers schema1 %s marker loss with a prefixed legacy %s and adopts its historical actor", async (status, outcome) => {
    const f = fixture(); f.update(1);
    f.store.observePullRequest(f.identities[0]!, observation(1), Date.now());
    const old = f.store.reserveReview(f.pr(), { reviewId: uuid(870), sessionId: uuid(871), maxAttempts: 3 }, Date.now())!;
    f.store.registerWorktree(f.pr(), path.join(f.configurations[0]!.path, ".worktrees", "pr-1"));
    f.store.pinReviewBase(old.id, "b".repeat(40), Date.now());
    f.store.startAttempt(old.id, { processOwner: "old-runtime", stdoutLogPath: path.join(f.directory, "old-out"), stderrLogPath: path.join(f.directory, "old-err") }, Date.now());
    if (status === "retry_wait") {
      const endedAt = Date.now();
      f.store.retryReview({ reviewId: old.id, attempt: 1 }, proof, { error: "old final marker missing", retryAt: endedAt }, endedAt);
    }
    f.publications.push({ id: "old-submitted-review", authorId: "historical-publisher", headSha: old.headSha, state: outcome,
      body: `number=1 fixture\nStable review identity: daynight review=${old.id} revision=1 head=${old.headSha}` });
    if (outcome === "COMMENTED") f.threads.push({ id: "legacy-feedback", reviewId: "old-submitted-review", isResolved: false });
    f.migrateSchema1();
    expect(f.store.getReviewPublication(old.id)).toMatchObject({ identityFormat: "legacy", phase: "prepared", publisherId: null });
    const recover = vi.fn(async () => proof);
    f.run(async (review, input) => {
      expect(review.id).toBe(old.id); expect(review.attemptCount).toBe(2);
      expect(input.publisherId).toBe("historical-publisher"); expect(input.publicationIdentityFormat).toBe("legacy");
      return true;
    });
    f.start({ processes: { ...f.processes, recover } });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "migrated unfinished publication confirmation");
    expect(f.launched).toHaveLength(1);
    expect(recover).toHaveBeenCalledTimes(status === "running" ? 1 : 0);
    expect(f.store.getReview(old.id)).toMatchObject({ status: "completed", attemptCount: 2 });
    expect(f.store.getReviewPublication(old.id)).toMatchObject({ identityFormat: "legacy", publisherId: "historical-publisher", remoteReviewId: "old-submitted-review", outcome: outcome === "APPROVED" ? "approved" : "commented" });
    expect(f.publications).toHaveLength(1);
  });

  it("retains cleanup uncertainty when a PR reopens before removal fails and blocks reuse after automatic restart", async () => {
    const f = fixture(2);
    f.update(1);
    const removal = deferred();
    f.cleanup(async () => removal.promise);
    const original = f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "review before cleanup");
    f.update(1, { state: "closed" });
    await waitFor(() => f.cleaned.length === 1, "in-flight removal");
    f.update(1, { state: "open" });
    await waitFor(() => f.store.getPullRequest(f.pr())?.state === "open", "reopening before removal result");
    expect(f.store.getPullRequest(f.pr())?.cleanupPending).toBe(true);
    expect(f.launched).toHaveLength(1);
    removal.reject(new GitCommandError("Removal outcome is uncertain.", new Error("capture abandoned"), false));
    await waitFor(() => f.events.some((event) => event.phase === "cleanup" && event.level === "error"), "uncertain removal diagnostic");
    original.abort.abort();
    await expect(original.completion).resolves.toEqual({ safeToReleaseLock: false });
    const persisted = openStore(f.paths.databaseFile);
    try {
      expect(persisted.getPullRequest(f.pr())).toMatchObject({ state: "open", cleanupPending: true });
      expect(persisted.listActiveReviews()).toEqual([]);
      expect(persisted.listCleanupCandidates().map((pr) => pr.number)).toEqual([1]);
    } finally { persisted.close(); }

    f.update(2, {}, 1);
    const restarted = f.start({ processes: createProcessSupervisor() });
    await waitFor(() => f.store.getPullRequest(f.pr(2, 1))?.completedRevision === 1, "independent review after automatic restart");
    expect(f.prepared.map((review) => review.number)).toEqual([1, 2]);
    expect(f.cleaned).toEqual([1]);
    expect(f.store.getPullRequest(f.pr())?.cleanupPending).toBe(true);
    restarted.abort.abort();
    await expect(restarted.completion).resolves.toEqual({ safeToReleaseLock: false });

    f.cleanup(undefined);
    const confirmed = f.start();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "reopened review after explicit exclusion");
    expect(f.store.getPullRequest(f.pr())?.cleanupPending).toBe(false);
    confirmed.abort.abort();
    await expect(confirmed.completion).resolves.toEqual({ safeToReleaseLock: true });
  });
});
