import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssignmentObservation, AssignmentSource } from "../../../src/commands/review/assignment.js";
import { createCoordinatorFixtures } from "./coordinator-fixtures.js";

const { fixture, waitFor, untilAborted, uuid } = createCoordinatorFixtures(true);

describe("Worker reviewer assignment", () => {
  it("keeps a running attempt on polling failure, then checks its publication after disable", async () => {
    const f = fixture();
    f.update(1);
    let observation: AssignmentObservation = { kind: "enabled", pullRequests: [{ projectId: uuid(1), repositoryId: "42", repositoryUrl: f.configuration.repositories[0]!.remote, number: 1 }] };
    let listener = () => {};
    const value = (scope: "user" | "project" | "worker") => ({ scope, scopeId: uuid(1), revision: "0", text: "", updatedAt: null });
    const source: AssignmentSource = {
      snapshot: () => observation,
      subscribe: callback => { listener = callback; return () => {}; },
      capturePrompt: async () => ({ values: { user: value("user"), project: value("project"), worker: value("worker") }, isCurrent: () => true }),
    };
    f.run(async (review, input) => {
      f.publications.push({ id: "published", authorId: "viewer", headSha: review.headSha, state: "APPROVED",
        body: `number=1 fixture\n<!-- daynight review=${review.id} revision=${review.revision} head=${review.headSha} -->` });
      return untilAborted(input.signal!);
    });
    f.start({ configuration: { ...f.configuration, repositories: [] }, assignment: { source, repositoryDirectory: path.join(f.directory, "repositories") } });
    await waitFor(() => f.launched.length === 1, "review launch");
    observation = { kind: "unavailable" }; listener();
    expect(f.launched[0]!.input.signal!.aborted).toBe(false);
    observation = { kind: "disabled" }; listener();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "completed", "publication verification after disable");
    expect(f.store.getReviewPublication(f.launched[0]!.review.id)).toMatchObject({ phase: "verified", outcome: "approved", remoteReviewId: "published" });
    expect(f.launched).toHaveLength(1);
  });
  it("admits an existing PR when it is assigned later and deduplicates project sources", async () => {
    const f = fixture(); f.update(1);
    let observation: AssignmentObservation = { kind: "enabled", pullRequests: [] };
    let listener = () => {}; const requested: string[] = [];
    const value = (scope: "user" | "project" | "worker") => ({ scope, scopeId: uuid(1), revision: "0", text: "", updatedAt: null });
    const source: AssignmentSource = { snapshot: () => observation, subscribe: callback => { listener = callback; return () => {}; },
      capturePrompt: async project => { requested.push(project); return { values: { user: value("user"), project: value("project"), worker: value("worker") }, isCurrent: () => true }; } };
    f.start({ configuration: { ...f.configuration, repositories: [] }, assignment: { source, repositoryDirectory: path.join(f.directory, "repositories") } });
    const item = { repositoryId: "42", repositoryUrl: f.configuration.repositories[0]!.remote, number: 1 };
    observation = { kind: "enabled", pullRequests: [{ ...item, projectId: uuid(2) }, { ...item, projectId: uuid(1) }] }; listener();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "completed", "assigned review");
    expect(requested).toEqual([uuid(1)]); expect(f.launched).toHaveLength(1);
    listener(); await waitFor(() => f.events.filter(e => e.phase === "poll").length > 0 || f.store.getRepository(f.pr())!.lastPollAt! > f.store.listReviews(f.pr())[0]!.updatedAt, "repeated candidate observation");
    expect(f.launched).toHaveLength(1); expect(f.store.listReviews(f.pr())).toHaveLength(1);
  });
  it("cancels preparation on disable without consuming an attempt, then resumes after enable", async () => {
    const f = fixture(); f.update(1);
    const item = { projectId: uuid(1), repositoryId: "42", repositoryUrl: f.configuration.repositories[0]!.remote, number: 1 };
    let observation: AssignmentObservation = { kind: "enabled", pullRequests: [item] }; let listener = () => {}; let first = true;
    const value = (scope: "user" | "project" | "worker") => ({ scope, scopeId: uuid(1), revision: "0", text: "", updatedAt: null });
    const source: AssignmentSource = { snapshot: () => observation, subscribe: callback => { listener = callback; return () => {}; },
      capturePrompt: async () => ({ values: { user: value("user"), project: value("project"), worker: value("worker") }, isCurrent: () => true }) };
    f.prepare(async (_review, signal) => { if (first) { first = false; await untilAborted(signal); } });
    f.start({ configuration: { ...f.configuration, repositories: [] }, assignment: { source, repositoryDirectory: path.join(f.directory, "repositories") } });
    await waitFor(() => f.prepared.length === 1, "preparation");
    observation = { kind: "disabled" }; listener();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "retry_wait", "preparation cancellation");
    expect(f.store.listReviews(f.pr())[0]!.attemptCount).toBe(0); expect(f.launched).toHaveLength(0);
    observation = { kind: "enabled", pullRequests: [item] }; listener();
    await waitFor(() => f.store.listReviews(f.pr())[0]?.status === "completed", "review after reenable");
    expect(f.launched).toHaveLength(1);
  });

});
