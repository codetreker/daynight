import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as filesystemPaths from "../../../src/platform/filesystem.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { listReviews } from "../../../src/commands/review/listing.js";
import { openStore } from "../../../src/commands/review/store.js";

const directories: string[] = [];
const row = (output: string, number = 101): string | undefined => output.split("\n").find((line) => line.startsWith(`#${number} `));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const diskFixture = async () => {
  const temporary = path.resolve(import.meta.dirname, "../../../../../.tmp/review-list-tests");
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, "snapshot 用户 "));
  directories.push(directory);
  const paths = resolveReviewPaths(directory);
  await mkdir(paths.stateDirectory);
  const source = "review:\n  repositories:\n    - remote: https://github.com/owner/repo.git\n      path: ../not-a-directory/repo\n    - remote: https://github.com/owner/other.git\n      path: ../not-a-directory/REPO\n";
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
    await writeFile(paths.configFile, "review:\n  repositories: []\n");
    await writeFile(paths.databaseFile, "invalid database");
    await expect(listReviews(paths)).rejects.toMatchObject({
      message: `Invalid configuration file ${paths.configFile}: review.repositories must be a nonempty sequence.`,
      cause: { message: "review.repositories must be a nonempty sequence." },
    });
    expect(await readFile(paths.databaseFile, "utf8")).toBe("invalid database");
  });
});
