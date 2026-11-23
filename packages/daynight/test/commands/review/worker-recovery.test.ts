import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssignmentObservation, AssignmentSource } from "../../../src/commands/review/assignment.js";
import { resolveWorkerReviewPaths } from "../../../src/commands/review/paths.js";
import { openStore } from "../../../src/commands/review/store.js";
import { createCoordinatorFixtures } from "./coordinator-fixtures.js";

const { fixture, waitFor, proof, uuid } = createCoordinatorFixtures(false);
afterEach(() => vi.unstubAllEnvs());

const assignment = (remote: string) => {
  const item = { projectId: uuid(1), repositoryId: "42", repositoryUrl: remote, number: 1 };
  let observation: AssignmentObservation = { kind: "enabled", pullRequests: [item] };
  let listener = () => {};
  const resource = (scope: "user" | "project" | "worker") => ({ scope, scopeId: uuid(1), revision: "0", text: "", updatedAt: null });
  const source: AssignmentSource = {
    snapshot: () => observation,
    subscribe: callback => { listener = callback; return () => {}; },
    capturePrompt: async () => ({ values: { user: resource("user"), project: resource("project"), worker: resource("worker") }, isCurrent: () => observation.kind === "enabled" }),
  };
  return { source, disabled: () => { observation = { kind: "disabled" }; listener(); }, notify: () => listener() };
};

describe("Worker reviewer recovery", () => {
  it("retries failed publication reads while disabled and resumes a pending final attempt after reopening SQLite", async () => {
    const f = fixture(); f.update(1); f.configuration.maxAttempts = 1;
    const a = assignment(f.configuration.repositories[0]!.remote);
    let failRead = true;
    f.snapshot(async () => { if (f.launched.length > 0 && failRead) throw new Error("fixture read unavailable"); });
    const input = { configuration: { ...f.configuration, repositories: [] }, assignment: { source: a.source, repositoryDirectory: path.join(f.directory, "repositories") } };
    const first = f.start(input);
    await waitFor(() => f.events.some(event => event.phase === "publication" && event.level === "error"), "publication read failure");
    const original = f.store.listReviews(f.pr())[0]!;
    expect(original).toMatchObject({ status: "running", attemptCount: 1 });
    expect(f.store.getReviewPublication(original.id)?.phase).toBe("pending");
    a.disabled();
    const failures = f.events.filter(event => event.phase === "publication" && event.level === "error").length;
    await waitFor(() => f.events.filter(event => event.phase === "publication" && event.level === "error").length > failures, "read-only retry while disabled");
    expect(f.launched).toHaveLength(1);
    first.abort.abort(); await first.completion;
    const recovered = openStore(f.paths.databaseFile);
    try {
      let excluded = 0;
      const second = f.start({ ...input, store: recovered, processes: { ...f.processes, recover: async () => { excluded++; return proof; } } });
      failRead = false;
      await waitFor(() => recovered.getReview(original.id)?.status === "completed", "publication after restart");
      expect(excluded).toBeGreaterThan(0);
      expect(recovered.getReview(original.id)?.attemptCount).toBe(1);
      expect(recovered.getReviewPublication(original.id)).toMatchObject({ phase: "verified", outcome: "approved", remoteReviewId: `remote-${original.id}` });
      expect(f.launched).toHaveLength(1);
      second.abort.abort(); await second.completion;
    } finally { recovered.close(); }
  });

  it("starts one same-head follow-up after feedback resolves, then cleans a closed PR outside the candidate list", async () => {
    const f = fixture(); f.update(1);
    const a = assignment(f.configuration.repositories[0]!.remote);
    f.run(async review => {
      if (review.revision === 1) {
        f.publications.push({ id: "comment", authorId: "viewer", headSha: review.headSha, state: "COMMENTED", body: `number=1 fixture\n<!-- daynight review=${review.id} revision=1 head=${review.headSha} -->` });
        f.threads.push({ id: "thread", reviewId: "comment", isResolved: false });
      }
      return true;
    });
    f.start({ configuration: { ...f.configuration, repositories: [] }, assignment: { source: a.source, repositoryDirectory: path.join(f.directory, "repositories") } });
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 1, "first comment publication");
    const first = f.store.listReviews(f.pr())[0]!;
    expect(f.store.getReviewPublication(first.id)).toMatchObject({ phase: "verified", outcome: "commented", followupConsumed: false });
    f.threads[0]!.isResolved = true; a.notify();
    await waitFor(() => f.store.getPullRequest(f.pr())?.completedRevision === 2, "same-head follow-up");
    expect(f.launched.map(entry => entry.review.revision)).toEqual([1, 2]);
    expect(f.launched[1]!.session).toBe(f.launched[0]!.session);
    expect(f.store.getReviewPublication(first.id)?.followupConsumed).toBe(true);
    f.update(1, { state: "closed" }); a.disabled();
    await waitFor(() => f.store.getPullRequest(f.pr())?.worktreePath === null, "terminal worktree cleanup");
    expect(f.cleaned).toEqual([1]); expect(f.launched).toHaveLength(2);
  });

  it("keeps standalone reviewer state and files independent across Worker reviewer restart", async () => {
    const f = fixture(); f.update(1);
    const sentinel = path.join(f.paths.stateDirectory, "old-reviewer-sentinel");
    writeFileSync(sentinel, "standalone retained");
    const originalRepository = f.store.getRepository(f.pr());
    vi.stubEnv("DN_CONFIG_DIR", f.paths.stateDirectory);
    const paths = resolveWorkerReviewPaths(path.join(f.directory, "home"));
    mkdirSync(paths.stateDirectory, { recursive: true });
    const workerStore = openStore(paths.databaseFile);
    const a = assignment(f.configuration.repositories[0]!.remote);
    const input = { configuration: { ...f.configuration, repositories: [] }, assignment: { source: a.source, repositoryDirectory: path.join(paths.stateDirectory, "repositories") } };
    try {
      const first = f.start({ ...input, store: workerStore });
      await waitFor(() => workerStore.getPullRequest(f.pr())?.completedRevision === 1, "Worker review in separate database");
      first.abort.abort(); await first.completion;
    } finally { workerStore.close(); }
    const reopened = openStore(paths.databaseFile);
    try {
      a.disabled();
      const second = f.start({ ...input, store: reopened });
      await waitFor(() => f.events.filter(event => event.phase === "repository").length >= 2, "separate database restart");
      expect(reopened.getPullRequest(f.pr())?.completedRevision).toBe(1);
      expect(f.launched).toHaveLength(1);
      second.abort.abort(); await second.completion;
    } finally { reopened.close(); }
    expect(f.store.getPullRequest(f.pr())).toBeNull();
    expect(f.store.getRepository(f.pr())).toEqual(originalRepository);
    expect(readFileSync(sentinel, "utf8")).toBe("standalone retained");
  });
});
