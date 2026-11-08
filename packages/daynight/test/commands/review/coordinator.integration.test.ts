import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GitCommandError } from "../../../src/commands/review/adapters/worktrees.js";
import { createCopilotRunner } from "../../../src/commands/review/adapters/copilot.js";
import { createGitHubClient } from "../../../src/commands/review/adapters/github.js";
import { createGitManager } from "../../../src/commands/review/adapters/worktrees.js";
import { runCoordinator } from "../../../src/commands/review/coordinator.js";
import { createProcessSupervisor } from "../../../src/commands/review/processes.js";
import { runForegroundReview } from "../../../src/commands/review/runtime.js";
import { prepareReviewSkill } from "../../../src/commands/review/skill.js";
import { openStore } from "../../../src/commands/review/store.js";

import { createCoordinatorFixtures } from "./coordinator-fixtures.js";

const { proof, uuid, deferred, waitFor, observation, fixture } = createCoordinatorFixtures(false);

describe("foreground review coordination", () => {
  it("retains the captured skill while running and resumes the same session with the updated skill after restart", async () => {
    const f = fixture(); f.update(1);
    const packageDirectory = path.join(f.directory, "package");
    const source = path.join(packageDirectory, "dist/commands/review/skills/daynight-review/SKILL.md");
    await mkdir(path.dirname(source), { recursive: true });
    const original = "---\nname: daynight-review\ndescription: Review pull requests\n---\n\nOriginal instructions.\n";
    const updated = original.replace("Original instructions.", "Updated instructions.");
    await writeFile(source, original);
    const invocations: { session: string; digest: string; contents: string }[] = [];
    const deps = {
      prepareSkill: prepareReviewSkill, openStore, createClient: createGitHubClient, createGit: createGitManager,
      createProcesses: createProcessSupervisor,
      createRunner: vi.fn<typeof createCopilotRunner>(({ skill }) => ({ run: async (...args) => {
        const review = args[0].getReview(args[1])!;
        invocations.push({ session: args[0].getPullRequest(review)!.sessionId!, digest: skill.digest, contents: await readFile(skill.entrypoint, "utf8") });
        return f.runner.run(...args);
      } })),
      coordinate: (options: Parameters<typeof runCoordinator>[0]) => runCoordinator({ ...options, client: f.client, git: f.git, processes: f.processes }),
    };
    const start = () => {
      const controller = new AbortController();
      return { controller, completion: runForegroundReview(f.configuration, f.paths, { packageDirectory, signal: controller.signal, dependencies: deps, log: () => {} }) };
    };
    const first = start(); let second: ReturnType<typeof start> | undefined;
    try {
      await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "first captured skill review");
      await writeFile(source, updated);
      f.update(1, { headSha: "d".repeat(40) });
      await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "second review with captured skill");
      expect(invocations).toHaveLength(2); expect(invocations.map(({ contents }) => contents)).toEqual([original, original]);
      expect(invocations[1]!.digest).toBe(invocations[0]!.digest);
      first.controller.abort(); await first.completion;
      second = start(); f.update(1, { headSha: "e".repeat(40) });
      await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 3, "resumed review with updated skill");
      expect(invocations).toHaveLength(3); expect(invocations[2]!.contents).toBe(updated);
      expect(invocations[2]!.digest).not.toBe(invocations[0]!.digest);
      expect(invocations.map(({ session }) => session)).toEqual([invocations[0]!.session, invocations[0]!.session, invocations[0]!.session]);
      expect(deps.createRunner).toHaveBeenCalledTimes(2);
    } finally {
      first.controller.abort(); await first.completion;
      if (second !== undefined) { second.controller.abort(); await second.completion; }
    }
  }, 30_000);

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
