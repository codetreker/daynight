import { describe, expect, it, vi } from "vitest";
import { createGitHubClient, type CommandExecutor, type CommandOptions, type CommandResult, type GitHubRepository } from "../../../src/commands/review/adapters/github.js";

const repository: GitHubRepository = { host: "github.com", githubId: "42", owner: "owner", name: "repo" };
const page = (nodes: unknown[] = [], totalCount = nodes.length, cursor: string | null = null) => ({
  nodes, totalCount, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const review = (id = "review-1", changes: Record<string, unknown> = {}) => ({
  id, author: { id: "viewer-1" }, commit: { oid: "head-11" }, body: "A review.\n\nDetails.", state: "COMMENTED", ...changes,
});
const thread = (id = "thread-1", changes: Record<string, unknown> = {}) => ({
  id, isResolved: false, comments: { totalCount: 2, nodes: [{ replyTo: null, pullRequestReview: { id: "review-1" } }] }, ...changes,
});
const snapshot = (changes: Record<string, unknown> = {}, viewer: unknown = { id: "viewer-1" }, repositoryChanges: Record<string, unknown> = {}) => ({
  data: { viewer, repository: { fullDatabaseId: "42", pullRequest: {
    number: 11, state: "OPEN", isDraft: false, headRefOid: "head-11", baseRefName: "main",
    reviews: page(), reviewThreads: page(), ...changes,
  }, ...repositoryChanges } },
});
const response = (body: unknown, headers = "", error: Error | null = null): CommandResult => ({
  stdout: `HTTP/2.0 200 OK\r\n${headers}\r\n${JSON.stringify(body)}`, stderr: "", error,
});
const fixture = (...responses: CommandResult[]) => {
  const calls: { args: readonly string[]; options: CommandOptions }[] = [];
  const execute: CommandExecutor = async (_file, args, options) => {
    calls.push({ args, options });
    const next = responses.shift();
    if (next === undefined) throw new Error("Unexpected GitHub request.");
    return next;
  };
  return { client: createGitHubClient({ execute, now: () => 100_000 }), calls, execute };
};

describe("GitHub review snapshot transport", () => {
  it("matches an exact int64 repository ID in the publication snapshot", async () => {
    const { client } = fixture(response(snapshot({}, undefined, { fullDatabaseId: "9007199254740993" })));
    await expect(client.getPullRequestReviewSnapshot({ ...repository, githubId: "9007199254740993" }, 11)).resolves.toMatchObject({ state: "open" });
  });
  it.each([null, 42, "0", "042", "-1", "9223372036854775808", "9007199254740993.0"])("rejects an invalid full database ID %s", async fullDatabaseId => {
    const { client } = fixture(response(snapshot({}, undefined, { fullDatabaseId })));
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow("full database ID");
  });
  it("reads authenticated identity, submitted/pending reviews, and all native thread forms without writes", async () => {
    const { client, calls } = fixture(response(snapshot({
      reviews: page([
        review(), review("review-2", { author: null, commit: null, body: "", state: "PENDING" }),
        review("review-3", { state: "APPROVED" }), review("review-4", { state: "DISMISSED" }), review("review-5", { state: "CHANGES_REQUESTED" }),
      ]),
      reviewThreads: page([
        thread("line", { isOutdated: false, subjectType: "LINE" }),
        thread("outdated", { isOutdated: true, subjectType: "LINE" }),
        thread("file", { subjectType: "FILE", isResolved: true, comments: { totalCount: 1, nodes: [{ replyTo: null, pullRequestReview: null }] } }),
      ]),
    })));
    const signal = new AbortController().signal;
    expect(await client.getPullRequestReviewSnapshot(repository, 11, signal)).toEqual({
      state: "open", draft: false, headSha: "head-11", baseRef: "main", viewerId: "viewer-1",
      reviews: [
        { id: "review-1", authorId: "viewer-1", headSha: "head-11", body: "A review.\n\nDetails.", state: "COMMENTED" },
        { id: "review-2", authorId: null, headSha: null, body: "", state: "PENDING" },
        ...["APPROVED", "DISMISSED", "CHANGES_REQUESTED"].map((state, index) => ({ id: `review-${index + 3}`, authorId: "viewer-1", headSha: "head-11", body: "A review.\n\nDetails.", state })),
      ],
      threads: [{ id: "line", reviewId: "review-1", isResolved: false }, { id: "outdated", reviewId: "review-1", isResolved: false }, { id: "file", reviewId: null, isResolved: true }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toContain("POST");
    expect(calls[0]!.args.find((arg) => arg.startsWith("query="))).toMatch(/^query=query PullRequestReviewSnapshot/);
    expect(calls[0]!.args.join(" ")).not.toContain("mutation");
    expect(calls[0]!.args).toContain("number=11");
    expect(calls[0]!.options).toEqual({ timeoutMs: 30_000, maxBufferBytes: 16 * 1024 * 1024, signal });
  });

  it("fully paginates reviews and threads independently before returning the snapshot", async () => {
    const threads = page([thread()], 1);
    const { client, calls } = fixture(
      response(snapshot({ reviews: page([review()], 3, "review-next"), reviewThreads: threads })),
      response(snapshot({ reviews: page([review("review-2")], 3, "review-last"), reviewThreads: threads })),
      response(snapshot({ reviews: page([review("review-3")], 3), reviewThreads: threads })),
    );
    const result = await client.getPullRequestReviewSnapshot(repository, 11);
    expect(result.reviews.map(({ id }) => id)).toEqual(["review-1", "review-2", "review-3"]);
    expect(result.threads).toEqual([{ id: "thread-1", reviewId: "review-1", isResolved: false }]);
    expect(calls.map(({ args }) => args.find((arg) => arg.startsWith("reviewCursor=")))).toEqual(["reviewCursor=null", "reviewCursor=review-next", "reviewCursor=review-last"]);
    expect(calls.every(({ args }) => args.includes("threadCursor=null"))).toBe(true);
  });

  it("continues thread pagination after collecting every review", async () => {
    const reviews = page([review()]);
    const { client, calls } = fixture(
      response(snapshot({ reviews, reviewThreads: page([thread()], 2, "thread-next") })),
      response(snapshot({ reviews, reviewThreads: page([thread("thread-2")], 2) })),
    );
    expect((await client.getPullRequestReviewSnapshot(repository, 11)).threads.map(({ id }) => id)).toEqual(["thread-1", "thread-2"]);
    expect(calls[1]!.args).toContain("threadCursor=thread-next");
  });

  it.each([
    ["wrong PR", { number: 12 }], ["missing threads", { reviewThreads: null }], ["invalid state", { state: "UNKNOWN" }],
    ["invalid draft", { isDraft: null }], ["missing head", { headRefOid: null }], ["missing base", { baseRefName: "" }],
    ["null thread", { reviewThreads: page([null]) }], ["missing thread resolution", { reviewThreads: page([thread("thread-1", { isResolved: undefined })]) }],
    ["missing thread root", { reviewThreads: page([thread("thread-1", { comments: { totalCount: 0, nodes: [] } })]) }],
    ["reply instead of root", { reviewThreads: page([thread("thread-1", { comments: { totalCount: 1, nodes: [{ replyTo: { id: "parent" }, pullRequestReview: null }] } })]) }],
    ["missing root review", { reviewThreads: page([thread("thread-1", { comments: { totalCount: 1, nodes: [{ replyTo: null }] } })]) }],
    ["invalid review state", { reviews: page([review("review-1", { state: "UNKNOWN" })]) }],
    ["missing review author", { reviews: page([review("review-1", { author: {} })]) }],
    ["missing review commit", { reviews: page([review("review-1", { commit: undefined })]) }],
    ["invalid review body", { reviews: page([review("review-1", { body: null })]) }],
    ["incomplete collection", { reviewThreads: page([], 1) }],
    ["too many entries", { reviews: page([review()], 0) }],
    ["duplicate entries", { reviewThreads: page([thread(), thread()], 2) }],
    ["empty next page", { reviews: page([], 1, "next") }],
    ["unnecessary next cursor", { reviews: page([review()], 1, "next") }],
  ])("cannot infer readiness from %s", async (_name, changes) => {
    const { client } = fixture(response(snapshot(changes)));
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow();
  });

  it.each([
    ["wrong repository", { fullDatabaseId: "43" }], ["missing repository ID", { fullDatabaseId: null }], ["deleted PR", { pullRequest: null }],
  ])("rejects %s", async (_name, changes) => {
    const { client } = fixture(response(snapshot({}, { id: "viewer-1" }, changes)));
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow();
  });

  it.each([null, {}, { id: "" }])("requires an authenticated viewer identity %s", async (viewer) => {
    const { client } = fixture(response(snapshot({}, viewer)));
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow();
  });

  it.each([
    ["head", { headRefOid: "head-12" }], ["base", { baseRefName: "release" }], ["draft", { isDraft: true }], ["state", { state: "CLOSED" }],
    ["review count", { reviews: page([review("review-2")], 3) }],
    ["duplicate ID", { reviews: page([review()], 2) }],
    ["repeated cursor", { reviews: page([review("review-2")], 3, "next") }],
    ["changed completed thread", { reviewThreads: page([thread("thread-2")]) }],
  ])("rejects %s changes during pagination", async (_name, changes) => {
    const totalCount = _name === "repeated cursor" ? 3 : 2;
    const { client } = fixture(
      response(snapshot({ reviews: page([review()], totalCount, "next"), reviewThreads: page([thread()]) })),
      response(snapshot({ reviews: page([review("review-2")], totalCount), reviewThreads: page([thread()]), ...changes })),
    );
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow();
  });

  it("rejects a changed authenticated viewer between pages", async () => {
    const { client } = fixture(
      response(snapshot({ reviews: page([review()], 2, "next") })),
      response(snapshot({ reviews: page([review("review-2")], 2) }, { id: "viewer-2" })),
    );
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow("viewer changed");
  });

  it("retains GraphQL rate-limit cooldown and rejects partial data carrying errors", async () => {
    const { client, calls } = fixture(response({ ...snapshot(), errors: [{ type: "RATE_LIMITED" }] }, "x-ratelimit-reset: 700\r\n"));
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toMatchObject({ name: "GitHubApiError", retryAt: 700_000 });
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toMatchObject({ retryAt: 700_000 });
    expect(calls).toHaveLength(1);
  });

  it("bounds aggregate snapshot bytes across otherwise valid pages", async () => {
    const first = snapshot({ reviews: page([review()], 2, "next") });
    const second = snapshot({ reviews: page([review("review-2")], 2) });
    const { execute } = fixture(response(first), response(second));
    const client = createGitHubClient({ execute, maxBufferBytes: Math.max(JSON.stringify(first).length, JSON.stringify(second).length) + 1 });
    await expect(client.getPullRequestReviewSnapshot(repository, 11)).rejects.toThrow("response size limit");
  });

  it("uses prepared port authentication and nested GraphQL variables", async () => {
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "fixture-token");
    try {
      const { client, calls } = fixture(response(snapshot()));
      await client.getPullRequestReviewSnapshot({ ...repository, host: "git.example:8443" }, 11);
      expect(calls[0]!.args.at(-1)).toBe("https://git.example:8443/api/graphql");
      expect(calls[0]!.args).toContain("variables[number]=11");
      expect(calls[0]!.args).toContain("variables[reviewCursor]=null");
    } finally { vi.unstubAllEnvs(); }
  });
});
