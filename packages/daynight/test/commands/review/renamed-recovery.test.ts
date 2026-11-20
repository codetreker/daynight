import path from "node:path";
import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCoordinator } from "../../../src/commands/review/coordinator.js";
import type { AssignmentObservation, AssignmentSource } from "../../../src/commands/review/assignment.js";
import { createGitTestFixtures, proof, rawGit, uuid } from "../../helpers/git-fixtures.js";

const fixtures = createGitTestFixtures("rename-recovery");
beforeAll(fixtures.initialize);
afterEach(fixtures.cleanup);
afterAll(fixtures.dispose);
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for retained reviewer recovery.");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

describe("renamed retained repository recovery", () => {
  it.each([{ kind: "disabled" } as const, { kind: "enabled", pullRequests: [] } as const])("reconciles pending publication and removes closed worktree with $kind assignment", async observation => {
    const f = fixtures.fixture();
    const local = await f.manager.ensureRepository(f.configuration);
    const review = f.reserve();
    const worktree = f.stageOwnedWorktree(local.root, review);
    f.store.captureReviewPublisher(review.id, "viewer");
    f.store.startAttempt(review.id, { processOwner: uuid(700), stdoutLogPath: path.join(f.directory, "out"), stderrLogPath: path.join(f.directory, "err") }, 30);
    f.store.retainPossiblePublication(review.id, "old process stopped", 31);
    f.client.resolveRepositoryById = async identity => ({ ...identity, owner: "owner", name: "renamed" });
    f.client.resolveRepository = async config => ({ host: config.host, githubId: config.name === "renamed" ? "42" : "99", owner: config.owner, name: config.name });
    f.client.getPullRequestReviewSnapshot = async () => ({ state: "open", draft: false, headSha: review.headSha, baseRef: review.baseRef, viewerId: "viewer",
      reviews: [{ id: "published", authorId: "viewer", state: "APPROVED", headSha: review.headSha,
        body: `<!-- daynight review=${review.id} revision=${review.revision} head=${review.headSha} -->` }], threads: [] });
    const source: AssignmentSource = { snapshot: (): AssignmentObservation => observation, subscribe: () => () => {}, capturePrompt: async () => { throw new Error("Unexpected reviewer admission."); } };
    const abort = new AbortController();
    const events: string[] = [];
    const completion = runCoordinator({ configuration: { pollIntervalMs: 20, maxConcurrentWorker: 1, agentTimeoutMs: 10000, maxAttempts: 3, retryDelayMs: 20, repositories: [] },
      store: f.store, client: f.client, git: f.manager, runner: { run: async () => { throw new Error("Unexpected reviewer launch."); } },
      processes: { onProcess: () => {}, stop: async () => {}, exclude: async () => proof, recover: async () => proof }, signal: abort.signal,
      log: event => { events.push(`${event.phase}: ${event.message}`); }, assignment: { source, repositoryDirectory: path.join(f.directory, "repositories") } });
    try {
      await waitFor(() => f.store.getReview(review.id)?.status === "completed");
      expect(f.store.getReviewPublication(review.id)).toMatchObject({ phase: "verified", outcome: "approved", remoteReviewId: "published" });
      expect(f.store.getRepository(f.repository)?.remote).toBe("https://github.com/owner/renamed.git");
      expect(rawGit(local.root, ["config", "remote.origin.url"])).toBe("https://github.com/owner/renamed.git");
      expect(existsSync(worktree)).toBe(true);
      f.update({ state: "closed" });
      await waitFor(() => !existsSync(worktree) && f.store.getPullRequest(review)?.worktreePath === null);
      expect(f.store.getPullRequest(review)).toMatchObject({ worktreePath: null, cleanupPending: false });
    } finally { abort.abort(); await completion; }
  }, 30_000);
});
