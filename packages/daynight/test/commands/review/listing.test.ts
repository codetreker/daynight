import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configurationDefaults, remoteIdentity } from "../../../src/commands/review/config.js";
import * as filesystemPaths from "../../../src/platform/filesystem.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { formatReviewListing, listReviews } from "../../../src/commands/review/listing.js";
import { openStore } from "../../../src/commands/review/store.js";
import type { ReviewConfiguration, RepositoryConfiguration } from "../../../src/commands/review/config.js";
import type { PullRequestState, RepositoryState, ReviewListingSnapshot, ReviewState, ReviewStatus } from "../../../src/commands/review/model.js";

const directories: string[] = [];
const configured = (name = "repo"): RepositoryConfiguration => ({
  ...remoteIdentity(`https://github.com/owner/${name}.git`, "remote"),
  remote: `https://github.com/owner/${name}.git`,
  path: path.resolve("clones", name),
});
const configuration = (...names: string[]): ReviewConfiguration => ({
  ...configurationDefaults,
  repositories: (names.length === 0 ? ["repo"] : names).map(configured),
});
const repository = (overrides: Partial<RepositoryState> = {}): RepositoryState => ({
  host: "github.com", githubId: "42", remote: "https://github.com/owner/repo.git", localPath: path.resolve("clone"),
  startPrNumber: 100, initializedAt: 0, lastPollAt: 1_000, lastPollError: null, ...overrides,
});
const pullRequest = (overrides: Partial<PullRequestState> = {}): PullRequestState => ({
  host: "github.com", githubId: "42", number: 101, state: "open", draft: false,
  headSha: "head", baseRef: "main", baseSha: "latest-base", desiredRevision: 1, completedRevision: 0,
  sessionId: null, sessionEstablished: false, worktreePath: null, cleanupPending: false,
  cleanupError: null, observedAt: 1_000, ...overrides,
});
const review = (overrides: Partial<ReviewState> = {}): ReviewState => ({
  host: "github.com", githubId: "42", number: 101, id: "review-1", revision: 1,
  headSha: "head", baseRef: "main", baseSha: "pinned-base", status: "running", attemptCount: 1,
  maxAttempts: 3, retryAt: null, processOwner: null, processId: null, processIdentity: null,
  stdoutLogPath: null, stderrLogPath: null, lastError: null, createdAt: 0, updatedAt: 100, ...overrides,
});
const snapshot = (overrides: Partial<ReviewListingSnapshot> = {}): ReviewListingSnapshot => ({
  repositories: [repository()], pullRequests: [pullRequest()], reviews: [], ...overrides,
});
const row = (output: string, number = 101): string | undefined => output.split("\n").find((line) => line.startsWith(`#${number} `));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persisted review listing projection", () => {
  it("groups only configured repositories in configuration order and sorts open PRs numerically", () => {
    const output = formatReviewListing(configuration("second", "repo", "missing"), snapshot({
      repositories: [repository(), repository({ githubId: "43", remote: "https://github.com/owner/second" }), repository({ githubId: "44", remote: "https://github.com/owner/removed" })],
      pullRequests: [pullRequest({ number: 111 }), pullRequest({ number: 102 }), pullRequest({ number: 103, state: "closed" }), pullRequest({ number: 104, state: "merged" }), pullRequest({ number: 105, githubId: "44" })],
    }));
    expect(output).toMatch(/^Local persisted snapshot/);
    expect(output).toContain("Running means recorded state");
    expect(output.indexOf("github.com/owner/second")).toBeLessThan(output.indexOf("github.com/owner/repo"));
    expect(output.indexOf("github.com/owner/repo")).toBeLessThan(output.indexOf("github.com/owner/missing"));
    expect(output.indexOf("#102 ")).toBeLessThan(output.indexOf("#111 "));
    expect(output).not.toMatch(/#103 |#104 |#105 |owner\/removed/);
    expect(output).toContain("github.com/owner/second\nLast observed: 1970-01-01T00:00:01.000Z\nNo tracked ongoing PRs.");
    expect(output).toContain("github.com/owner/missing\nLast observed: never\nNot initialized.");
  });

  it("matches remote aliases by coordinate and stable identity regardless of clone relocation", () => {
    const output = formatReviewListing(configuration(), snapshot({ repositories: [repository({ remote: "git@GITHUB.COM:Owner/Repo.git", localPath: path.resolve("different-clone") })] }));
    expect(row(output)).toMatch(/#101\s+Open\s+Pending\s+-$/);
  });

  it("does not attach state from another repository sharing the configured clone path", () => {
    const output = formatReviewListing(configuration(), snapshot({ repositories: [repository({ remote: "https://github.com/owner/removed", localPath: configured().path })] }));
    expect(output).toContain("Not initialized.");
    expect(row(output)).toBeUndefined();
  });

  it("rejects ambiguous persisted GitHub IDs for the configured coordinate", () => {
    expect(() => formatReviewListing(configuration(), snapshot({ repositories: [repository(), repository({ githubId: "99", remote: "git@github.com:OWNER/REPO.git" })] }))).toThrow("Ambiguous persisted repository identity for github.com/owner/repo");
  });

  it("distinguishes missing and uninitialized state from an initialized zero boundary", () => {
    expect(formatReviewListing(configuration(), null)).toContain("Not initialized.");
    const uninitialized = formatReviewListing(configuration(), snapshot({ repositories: [repository({ startPrNumber: null, initializedAt: null, lastPollAt: null, lastPollError: "API unavailable" })] }));
    expect(uninitialized).toContain("Last observed: never\nLast poll error: API unavailable\nNot initialized.");
    expect(row(uninitialized)).toBeUndefined();
    const empty = formatReviewListing(configuration(), snapshot({ repositories: [repository({ startPrNumber: 0 })], pullRequests: [] }));
    expect(empty).toContain("Last observed: 1970-01-01T00:00:01.000Z\nNo tracked ongoing PRs.");
    expect(empty).not.toContain("Not initialized.");
  });

  it("omits the boundary notice while excluding PRs at or below the permanent boundary", () => {
    const output = formatReviewListing(configuration(), snapshot({ pullRequests: [pullRequest({ number: 99 }), pullRequest({ number: 100 }), pullRequest()] }));
    expect(output).not.toContain("Tracking PRs above");
    expect(row(output, 99)).toBeUndefined();
    expect(row(output, 100)).toBeUndefined();
    expect(row(output)).toBeDefined();
  });

  it.each([
    ["preparing", "Preparing", 0], ["running", "Running", 1], ["retry_wait", "Retry waiting", 2],
    ["completed", "Completed", 1], ["failed", "Failed", 3], ["interrupted", "Interrupted", 1],
  ] satisfies [ReviewStatus, string, number][])("renders current %s review state and attempts", (status, name, attempts) => {
    const output = formatReviewListing(configuration(), snapshot({ reviews: [review({ status, attemptCount: attempts })] }));
    expect(row(output)).toMatch(new RegExp(`#101\\s+Open\\s+${name}\\s+${attempts}$`));
  });

  it("keeps a review current when the observed base SHA advances without a new target revision", () => {
    const output = formatReviewListing(configuration(), snapshot({ pullRequests: [pullRequest({ baseSha: "new-observed-base", completedRevision: 1 })], reviews: [review({ status: "completed", baseSha: "old-pinned-base" })] }));
    expect(row(output)).toMatch(/Open\s+Completed\s+1$/);
  });

  it.each(["completed", "failed"] as const)("does not apply a previous %s review or its diagnostics to a new revision", (status) => {
    const output = formatReviewListing(configuration(), snapshot({ pullRequests: [pullRequest({ desiredRevision: 2, headSha: "new-head" })], reviews: [review({ status, lastError: "old target error", retryAt: 10_000 })] }));
    expect(row(output)).toMatch(/Open\s+Pending\s+-$/);
    expect(output).not.toContain("old target error");
    expect(output).not.toContain("Retry at:");
  });

  it.each([{ headSha: "other-head" }, { baseRef: "release" }, { revision: 2 }])("requires revision, head and base branch to match the current target: %j", (change) => {
    const output = formatReviewListing(configuration(), snapshot({ reviews: [review({ status: "failed", ...change })] }));
    expect(row(output)).toMatch(/Open\s+Pending\s+-$/);
  });

  it.each(["preparing", "running", "retry_wait", "interrupted"] as const)("shows a previous active %s review separately from the pending target", (status) => {
    const output = formatReviewListing(configuration(), snapshot({
      pullRequests: [pullRequest({ desiredRevision: 2, headSha: "new-head" })],
      reviews: [review({ status, attemptCount: 2, retryAt: 5_000, lastError: "previous target failure" })],
    }));
    expect(row(output)).toMatch(/Open\s+Pending \(previous revision .+\)\s+-$/);
    expect(output).toContain("Previous revision 1:");
    expect(output).toContain("attempts: 2/3");
    expect(output).toContain("Previous revision Retry at: 1970-01-01T00:00:05.000Z");
    expect(output).toContain("Previous revision Error: previous target failure");
  });

  it("includes Draft PRs as paused while preserving recorded execution details", () => {
    const output = formatReviewListing(configuration(), snapshot({
      pullRequests: [pullRequest({ draft: true }), pullRequest({ number: 102, draft: true, desiredRevision: 2 })],
      reviews: [review({ status: "interrupted", lastError: "child status uncertain" }), review({ number: 102, status: "running" })],
    }));
    expect(row(output)).toMatch(/Draft\s+Paused\s+1$/);
    expect(output).toContain("Recorded review: Interrupted\n  Error: child status uncertain");
    expect(row(output, 102)).toMatch(/Draft\s+Paused\s+-$/);
    expect(output).toContain("Previous revision 1: Running; attempts: 1/3");
  });

  it.each([false, true])("shows pending worktree cleanup and its saved error for draft=%s", (draft) => {
    const output = formatReviewListing(configuration(), snapshot({
      pullRequests: [pullRequest({ draft, desiredRevision: 2, cleanupPending: true, cleanupError: "Git outcome\u001b[2J\nuncertain" })],
      reviews: [review({ status: "interrupted", lastError: "child status uncertain" })],
    }));
    expect(row(output)).toMatch(draft ? /Draft\s+Paused\s+-$/ : /Open\s+Pending \(cleanup blocked\)\s+-$/);
    expect(output).toContain("  Worktree cleanup: Pending\n  Cleanup error: Git outcome\\u001b[2J\\u000auncertain");
    expect(output).toContain("Previous revision 1: Interrupted; attempts: 1/3");
    expect(output).toContain("Previous revision Error: child status uncertain");
  });

  it("prints retry deadlines and saved diagnostics while escaping terminal controls", () => {
    const output = formatReviewListing(configuration(), snapshot({
      repositories: [repository({ lastPollError: "API\u001b[2J\nerror\u009b1m" })],
      reviews: [review({ status: "retry_wait", retryAt: 5_000, lastError: "spawn\r\tfailed\u001b]0;title\u0007\u2028" })],
    }));
    expect(output).toContain("Last poll error: API\\u001b[2J\\u000aerror\\u009b1m");
    expect(output).toContain("  Retry at: 1970-01-01T00:00:05.000Z");
    expect(output).toContain("  Error: spawn\\u000d\\u0009failed\\u001b]0;title\\u0007\\u2028");
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028]/);
  });
});

const diskFixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/review-list-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "snapshot 用户 "));
  directories.push(directory);
  const paths = resolveReviewPaths(directory);
  await mkdir(paths.stateDirectory);
  const source = "repositories:\n  - remote: https://github.com/owner/repo.git\n    path: ../not-a-directory/repo\n  - remote: https://github.com/owner/other.git\n    path: ../not-a-directory/REPO\n";
  await writeFile(paths.configFile, source);
  await writeFile(path.join(directory, "not-a-directory"), "A path probe would reject this ancestor.");
  return { paths, directory, source };
};

describe("review listing reads", () => {
  it("does not require a valid server address for persisted review queries", async () => {
    const { paths, source } = await diskFixture();
    await writeFile(paths.configFile, `serverUrl: invalid-for-server\n${source}`);
    expect(await listReviews(paths)).toContain("github.com/owner/repo");
  });

  it("reports unconfigured review before opening SQLite in server-only configuration", async () => {
    const { paths } = await diskFixture();
    await writeFile(paths.configFile, "serverUrl: http://localhost:8787\n");
    await writeFile(paths.databaseFile, "invalid database");
    await expect(listReviews(paths)).rejects.toThrow("Review repositories are not configured; use daynight review add-repo <remote>");
    expect(await readFile(paths.databaseFile, "utf8")).toBe("invalid database");
  });

  it("reads configuration without probing clone paths or creating missing runtime state", async () => {
    const { paths, directory, source } = await diskFixture();
    const physical = vi.spyOn(filesystemPaths, "resolvePhysicalDirectory").mockRejectedValue(new Error("Physical paths must not be probed."));
    const caseProbe = vi.spyOn(filesystemPaths, "missingPathsReferToSameDirectory").mockRejectedValue(new Error("Case probes must not be created."));
    const output = await listReviews(paths);
    expect(output.match(/Not initialized\./g)).toHaveLength(2);
    expect(physical).not.toHaveBeenCalled();
    expect(caseProbe).not.toHaveBeenCalled();
    expect(await readdir(paths.stateDirectory)).toEqual(["config.yml"]);
    expect(await readdir(directory)).toEqual([".daynight", "not-a-directory"]);
    expect(await readFile(paths.configFile, "utf8")).toBe(source);
  });

  it("reads persisted open PRs while leaving writer state and application files unchanged", async () => {
    const { paths, source } = await diskFixture();
    const store = openStore(paths.databaseFile);
    try {
      const identity = { host: "github.com", githubId: "42" };
      store.registerRepository({ ...identity, remote: "git@github.com:Owner/Repo.git", localPath: path.join(paths.stateDirectory, "old-clone") });
      store.initializeRepository(identity, 0, 0);
      store.observePullRequest(identity, { number: 12, state: "open", draft: true, headSha: "head", baseRef: "main", baseSha: "base" }, 1_000);
      store.observePullRequest(identity, { number: 13, state: "closed", draft: false, headSha: "head", baseRef: "main", baseSha: "base" }, 1_000);
      store.recordPollSuccess(identity, 1_000);
      store.recordPollError(identity, "API unavailable");
      const previousRepository = store.getRepository(identity);
      const previousPullRequests = store.listPullRequests(identity);
      const output = await listReviews(paths);
      expect(row(output, 12)).toMatch(/Draft\s+Paused\s+-$/);
      expect(row(output, 13)).toBeUndefined();
      expect(output).toContain("Last poll error: API unavailable");
      expect(output).not.toContain("Tracking PRs above");
      expect(store.getRepository(identity)).toEqual(previousRepository);
      expect(store.listPullRequests(identity)).toEqual(previousPullRequests);
      expect(store.listReviews({ ...identity, number: 12 })).toEqual([]);
      expect(await readFile(paths.configFile, "utf8")).toBe(source);
      for (const filename of [paths.lockFile, paths.logsDirectory, paths.copilotDirectory, paths.temporaryDirectory]) {
        await expect(readFile(filename)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      store.close();
    }
  });

  it("shows reopened PR cleanup blocking until the writer records confirmed cancellation", async () => {
    const { paths } = await diskFixture();
    const store = openStore(paths.databaseFile);
    try {
      const identity = { host: "github.com", githubId: "42" };
      const pr = { ...identity, number: 12 };
      const proof = { operationsStopped: true, processesExcluded: true } as const;
      const observation = { number: 12, state: "open", draft: false, headSha: "head", baseRef: "main", baseSha: "base" } as const;
      const worktree = path.join(paths.stateDirectory, "old-clone", ".worktrees", "pr-12");
      store.registerRepository({ ...identity, remote: "https://github.com/owner/repo.git", localPath: path.join(paths.stateDirectory, "old-clone") });
      store.initializeRepository(identity, 0, 0);
      store.observePullRequest(identity, observation, 1_000);
      const preparing = store.reserveReview(pr, {
        reviewId: "00000000-0000-4000-8000-000000000001", sessionId: "00000000-0000-4000-8000-000000000002", maxAttempts: 3,
      }, 1_100)!;
      store.registerWorktree(pr, worktree);
      store.observePullRequest(identity, { ...observation, state: "closed" }, 1_200);
      store.supersedeReview(preparing.id, proof, 1_300);
      store.recordCleanupError(pr, worktree, "Git cleanup outcome\u001b[2J uncertain");
      store.observePullRequest(identity, observation, 1_400);

      const pending = store.getPullRequest(pr);
      expect(pending).toMatchObject({ state: "open", cleanupPending: true, desiredRevision: 2 });
      expect(store.listCandidates(1_500)).toEqual([]);
      const blocked = await listReviews(paths);
      expect(row(blocked, 12)).toMatch(/Open\s+Pending \(cleanup blocked\)\s+-$/);
      expect(blocked).toContain("  Worktree cleanup: Pending\n  Cleanup error: Git cleanup outcome\\u001b[2J uncertain");
      expect(store.getPullRequest(pr)).toEqual(pending);
      expect(store.listCandidates(1_500)).toEqual([]);

      store.cancelCleanup(pr, worktree, proof);
      expect(store.listCandidates(1_600)).toHaveLength(1);
      const cleared = await listReviews(paths);
      expect(row(cleared, 12)).toMatch(/Open\s+Pending\s+-$/);
      expect(cleared).not.toContain("Worktree cleanup:");
      expect(cleared).not.toContain("Cleanup error:");
    } finally {
      store.close();
    }
  });

  it("preserves the missing configuration cause and does not create its directory", async () => {
    const { directory } = await diskFixture();
    const paths = resolveReviewPaths(path.join(directory, "absent-home"));
    await expect(listReviews(paths)).rejects.toMatchObject({ message: `Cannot read configuration file ${paths.configFile}.`, cause: { code: "ENOENT" } });
    await expect(readdir(path.join(directory, "absent-home"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports invalid configuration before opening SQLite", async () => {
    const { paths } = await diskFixture();
    await writeFile(paths.configFile, "repositories: []\n");
    await writeFile(paths.databaseFile, "invalid database");
    await expect(listReviews(paths)).rejects.toMatchObject({
      message: `Invalid configuration file ${paths.configFile}: repositories must be a nonempty sequence.`,
      cause: { message: "repositories must be a nonempty sequence." },
    });
    expect(await readFile(paths.databaseFile, "utf8")).toBe("invalid database");
  });
});
