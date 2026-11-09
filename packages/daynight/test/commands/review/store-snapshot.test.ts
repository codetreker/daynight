import { describe, expect, it, vi } from "vitest";
import { createReviewSnapshotFixtures } from "./snapshot-fixtures.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const { repository, uuid, excluded, readSnapshot, connect, fixture } = createReviewSnapshotFixtures(true);

describe("review listing snapshots and automatic upgrades", () => {
  it("includes open drafts, completed and exhausted reviews while omitting closed, merged and cutoff PRs", () => {
    const { file, store, observe, reserve, launch } = fixture();
    expect(observe(100)).toBeNull();
    observe(101, { draft: true });
    observe(102);
    const completed = launch(reserve(102));
    store.completeReview({ reviewId: completed.id, attempt: 1 }, excluded, 50);
    observe(103);
    const failed = launch(reserve(103, 1));
    store.retryReview({ reviewId: failed.id, attempt: 1 }, excluded, { error: "attempt exhausted", retryAt: 60 }, 50);
    observe(104); reserve(104); observe(104, { state: "closed" }, 60);
    observe(105); reserve(105); observe(105, { state: "merged" }, 60);
    const snapshot = readSnapshot(file);
    expect(snapshot?.repositories).toEqual(store.listRepositories());
    expect(snapshot?.pullRequests.map(({ number, draft }) => ({ number, draft }))).toEqual([
      { number: 101, draft: true }, { number: 102, draft: false }, { number: 103, draft: false },
    ]);
    expect(snapshot?.reviews.map(({ number, status, baseSha }) => ({ number, status, baseSha }))).toEqual([
      { number: 102, status: "completed", baseSha: "pinned-base" },
      { number: 103, status: "failed", baseSha: "pinned-base" },
    ]);
  });

  it.each(["preparing", "running", "retry_wait", "interrupted"] as const)("retains a previous %s review behind a newer target and omits older terminal history", (status) => {
    const { file, store, observe, reserve, launch } = fixture();
    observe();
    const first = launch(reserve());
    store.completeReview({ reviewId: first.id, attempt: 1 }, excluded, 50);
    observe(101, { headSha: "second-head" }, 60);
    const previous = reserve();
    if (status !== "preparing") {
      launch(previous);
      if (status === "retry_wait") store.retryReview({ reviewId: previous.id, attempt: 1 }, excluded, { error: "retry later", retryAt: 90 }, 70);
      if (status === "interrupted") store.markInterrupted(previous.id, "execution interrupted", 70);
    }
    observe(101, { headSha: "third-head", baseRef: "release" }, 80);
    const snapshot = readSnapshot(file);
    expect(snapshot?.pullRequests[0]).toMatchObject({ desiredRevision: 3, headSha: "third-head", baseRef: "release" });
    expect(snapshot?.reviews).toEqual([store.getReview(previous.id)]);
    expect(snapshot?.reviews[0]?.status).toBe(status);
  });

  it("matches the current review by revision, head and base branch without requiring the observed base tip", () => {
    const { file, store, observe, reserve, launch } = fixture();
    observe();
    const completed = launch(reserve());
    store.completeReview({ reviewId: completed.id, attempt: 1 }, excluded, 50);
    const sql = connect(file);
    const insert = sql.prepare(`INSERT INTO reviews(id, host, github_id, number, revision, head_sha, base_ref, status, max_attempts, created_at, updated_at)
      VALUES(?, 'github.com', '42', 101, ?, ?, ?, 'completed', 3, 60, 60)`);
    insert.run(uuid(100), 2, "head-101", "main");
    insert.run(uuid(101), 1, "wrong-head", "main");
    insert.run(uuid(102), 1, "head-101", "wrong-base");
    expect(readSnapshot(file)?.reviews).toEqual([store.getReview(completed.id)]);
  });

  it("leaves persisted state, schema and review recovery statuses unchanged", () => {
    const { file, store, observe, reserve } = fixture();
    observe();
    const interrupted = reserve();
    store.markInterrupted(interrupted.id, "original interruption", 40);
    store.recordPollError(repository, "original poll error");
    const sql = connect(file);
    const persisted = () => ({
      version: sql.pragma("user_version", { simple: true }),
      schema: sql.prepare("SELECT * FROM sqlite_master ORDER BY name").all(),
      repositories: sql.prepare("SELECT * FROM repositories ORDER BY host, github_id").all(),
      pullRequests: sql.prepare("SELECT * FROM pull_requests ORDER BY host, github_id, number").all(),
      reviews: sql.prepare("SELECT * FROM reviews ORDER BY id").all(),
    });
    const before = persisted();
    expect(readSnapshot(file)?.reviews[0]).toMatchObject({ status: "interrupted", lastError: "original interruption" });
    expect(readSnapshot(file)?.repositories[0]?.lastPollError).toBe("original poll error");
    expect(persisted()).toEqual(before);
  });

  it("does not mistake an unrecognized sqlite-prefixed user index for an internal object", () => {
    const { file } = fixture();
    const sql = connect(file); sql.exec("CREATE INDEX sqliteXcustom ON reviews(id)");
    expect(() => readSnapshot(file)).toThrow("invalid-format");
    expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name='sqliteXcustom'").get()).toEqual({ name: "sqliteXcustom" });
  });
});
