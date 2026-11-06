import path from "node:path";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createGitManager } from "../../src/commands/review/adapters/worktrees.js";
import { executeCommand } from "../../src/commands/review/adapters/github.js";
import type { CommandExecutor, GitHubClient } from "../../src/commands/review/adapters/github.js";
import { openStore } from "../../src/commands/review/store.js";
import type { Store } from "../../src/commands/review/store.js";
import type { PullRequestObservation } from "../../src/commands/review/model.js";
import { writeGitSnapshot } from "./git-objects.js";
import type { GitSnapshotEntry } from "./git-objects.js";
import { createMemoryDatabase } from "./sqlite.js";

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const proof = { processesExcluded: true, operationsStopped: true } as const;
const nativeEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
export const rawGit = (directory: string, args: string[], input?: string): string => execFileSync("git", ["-C", directory, ...args], {
  encoding: "utf8", env: nativeEnvironment(), timeout: 20_000, ...(input === undefined ? {} : { input }), stdio: ["pipe", "pipe", "pipe"],
}).trim();
export const commit = (bare: string, contents: string, parent?: string, extraEntries: readonly GitSnapshotEntry[] = []): string => writeGitSnapshot(
  (args, input) => rawGit(bare, args, input),
  [{ path: ".gitattributes", mode: "100644", contents: "* -text\n" }, { path: "file.txt", mode: "100644", contents }, ...extraEntries],
  `${contents}\n`, parent === undefined ? [] : [parent],
);

export const createGitTestFixtures = (name: string, prepareSource?: (upstream: string, base: string) => void) => {
  const directories: string[] = [];
  const stores = new Set<Store>();
  let root: string | undefined;
  let seed: { directory: string; upstream: string; base: string; head: string } | undefined;
  const initialize = (): void => {
    const fixtures = path.resolve(import.meta.dirname, "../../../../.tmp/git-tests");
    mkdirSync(fixtures, { recursive: true });
    const directory = mkdtempSync(path.join(fixtures, `${name} `));
    root = directory;
    const upstream = path.join(directory, "source-template.git");
    mkdirSync(upstream);
    rawGit(upstream, ["init", "--bare", "--initial-branch=main"]);
    const base = commit(upstream, "base\n");
    const head = commit(upstream, "PR\n", base);
    rawGit(upstream, ["update-ref", "refs/heads/main", base]);
    rawGit(upstream, ["update-ref", "refs/pull/101/head", head]);
    prepareSource?.(upstream, base);
    seed = { directory, upstream, base, head };
  };

  const fixture = (gitConfiguration: readonly string[] = []) => {
    if (seed === undefined) throw new Error("Git fixtures must be initialized before use.");
    const directory = mkdtempSync(path.join(seed.directory, "Git 中文 "));
    directories.push(directory);
    const upstream = path.join(directory, "source.git");
    cpSync(seed.upstream, upstream, { recursive: true, force: false, errorOnExist: true });
    const { base, head } = seed;
    const configuration = { remote: "https://github.com/owner/repo.git", coordinate: "github.com/owner/repo", host: "github.com", owner: "owner", name: "repo", path: path.join(directory, "checkout") };
    const repository = { host: "github.com", githubId: "42", owner: "owner", name: "repo" };
    let observation: PullRequestObservation = { number: 101, state: "open", draft: false, headSha: head, baseRef: "main", baseSha: base };
    let onGet: (() => void) | undefined;
    const client: GitHubClient = {
      resolveRepository: async (config) => ({ ...repository, githubId: config.owner === "owner" && config.name === "repo" ? "42" : "43", host: config.host }),
      listPullRequestNumbers: async () => [101],
      listOpenPullRequests: async () => [observation],
      getPullRequest: async () => { onGet?.(); return { ...observation }; },
      getPullRequestReviewSnapshot: async () => { throw new Error("Unexpected review snapshot request in worktree fixture."); }, getPullRequestChecks: async () => { throw new Error("Git preparation must not query CI readiness."); },
    };
    const calls: { file: string; args: readonly string[] }[] = [];
    let intercept: CommandExecutor | undefined;
    const execute: CommandExecutor = async (file, args, options) => {
      calls.push({ file, args });
      if (intercept !== undefined) return intercept(file, args, options);
      if (file === "gh") return { stdout: "fixture-secret\n", stderr: "", error: null };
      const result = await executeCommand(file, [...gitConfiguration, "-c", "protocol.file.allow=always", "-c", `url.${pathToFileURL(upstream).href}.insteadOf=https://${configuration.host}/owner/repo.git`, ...args], options);
      if (result.error !== null && args.includes("clone")) process.stderr.write(`Local Git clone fixture failure: ${result.stderr}\n`);
      return result;
    };
    const database = createMemoryDatabase();
    const store = openStore(database);
    stores.add(store);
    store.registerRepository({ ...repository, remote: configuration.remote, localPath: configuration.path });
    store.initializeRepository(repository, 100, 1);
    store.observePullRequest(repository, observation, 2);
    let nextId = 1;
    const reserve = () => {
      const review = store.reserveReview({ ...repository, number: 101 }, { reviewId: uuid(nextId++), sessionId: uuid(500), maxAttempts: 3 }, 10);
      if (review === null) throw new Error("Expected a review reservation.");
      return review;
    };
    const manager = createGitManager({ temporaryDirectory: path.join(directory, "tmp"), client, execute, now: () => 20 });
    const update = (partial: Partial<PullRequestObservation>) => { observation = { ...observation, ...partial }; store.observePullRequest(repository, observation, 15); };
    const nextRevision = (reviewId: string, nextHead: string) => {
      update({ headSha: nextHead });
      store.supersedeReview(reviewId, proof, 16);
      rawGit(upstream, ["update-ref", "refs/pull/101/head", nextHead]);
      return reserve();
    };
    return { directory, upstream, base, head, configuration, repository, client, database, store, calls, execute, manager, reserve, update, nextRevision,
      setIntercept: (value: CommandExecutor | undefined) => { intercept = value; }, setOnGet: (value: (() => void) | undefined) => { onGet = value; } };
  };

  const cleanup = (): void => {
    for (const store of stores) store.close();
    stores.clear();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  };
  const dispose = (): void => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
    seed = undefined;
  };
  return { initialize, fixture, cleanup, dispose };
};

export type GitFixtureFactory = ReturnType<typeof createGitTestFixtures>["fixture"];
