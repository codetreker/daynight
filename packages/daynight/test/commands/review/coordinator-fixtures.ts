import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, expect } from "vitest";
import { runCoordinator } from "../../../src/commands/review/coordinator.js";
import type { CoordinatorEvent, CoordinatorOptions } from "../../../src/commands/review/coordinator.js";
import type { CopilotAttemptOutcome, CopilotRunOptions } from "../../../src/commands/review/adapters/copilot.js";
import type { LocalRepository } from "../../../src/commands/review/adapters/worktrees.js";
import type { GitHubClient, GitHubRepository } from "../../../src/commands/review/adapters/github.js";
import { resolveReviewPaths } from "../../../src/commands/review/paths.js";
import { openStore } from "../../../src/commands/review/store.js";
import type { Store } from "../../../src/commands/review/store.js";
import type { PullRequestObservation, PullRequestReviewSnapshot, ReviewState } from "../../../src/commands/review/model.js";

import { createMemoryDatabase } from "../../helpers/sqlite.js";

export const createCoordinatorFixtures = (memory: boolean) => {
  const root = path.resolve(import.meta.dirname, "../../../../../.tmp/coordinator-tests");
  const fixtures: { directory: string; store: Store; runs: { abort: AbortController; completion: Promise<{ safeToReleaseLock: boolean }> }[] }[] = [];
  const proof = { processesExcluded: true, operationsStopped: true } as const;
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
    return { promise, resolve, reject };
  };
  const waitFor = async (condition: () => boolean, description: string, timeoutMs = 5_000): Promise<void> => {
    const until = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() >= until) throw new Error(`Timed out waiting for ${description}.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const untilAborted = async (signal: AbortSignal): Promise<never> => {
    signal.throwIfAborted();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    throw new Error("Unreachable abort wait.");
  };
  const observation = (number: number, change: Partial<PullRequestObservation> = {}): PullRequestObservation => ({
    number, state: "open", draft: false, headSha: "a".repeat(40), baseRef: "main", baseSha: "b".repeat(40), ...change,
  });

  const fixture = (repositoryCount = 1, initialized = true, repositoryHost = (_index: number): string => "github.com") => {
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(path.join(root, "Coordinator 中文 "));
    const paths = resolveReviewPaths(path.join(directory, "home"));
    mkdirSync(paths.stateDirectory, { recursive: true });
    const database = memory ? createMemoryDatabase() : paths.databaseFile;
    let store = openStore(database);
    const configurations = Array.from({ length: repositoryCount }, (_, index) => {
      const host = repositoryHost(index);
      return { remote: `https://${host}/owner/repo${index}.git`, coordinate: `${host}/owner/repo${index}`, host, owner: "owner", name: `repo${index}`, path: path.join(directory, `repo${index}`) };
    });
    const identities = configurations.map((config, index): GitHubRepository => ({ host: config.host, githubId: String(42 + index), owner: config.owner, name: config.name }));
    const snapshots = identities.map(() => new Map<number, PullRequestObservation>());
    const polls = identities.map(() => 0);
    const locals = configurations.map((configuration, index): LocalRepository => ({ configuration, repository: identities[index]!, root: configuration.path,
      commonDirectory: path.join(configuration.path, ".git"), rootIdentity: `root-${index}`, commonIdentity: `common-${index}` }));
    for (const [index, config] of configurations.entries()) {
      store.registerRepository({ ...identities[index]!, remote: config.remote, localPath: config.path });
      if (initialized) store.initializeRepository(identities[index]!, 0, Date.now());
    }
    const events: CoordinatorEvent[] = [];
    const prepared: ReviewState[] = [];
    const launched: { review: ReviewState; session: string; input: CopilotRunOptions }[] = [];
    const cleaned: number[] = [];
    const publications: PullRequestReviewSnapshot["reviews"] = [];
    const threads: PullRequestReviewSnapshot["threads"] = [];
    let onSnapshot: (() => Promise<void>) | undefined;
    const checked: { number: number; headSha: string; baseRef: string }[] = [];
    let onPoll: ((index: number) => Promise<void>) | undefined;
    let onPrepare: ((review: ReviewState, signal: AbortSignal) => Promise<void>) | undefined;
    let onRun: ((review: ReviewState, input: CopilotRunOptions) => Promise<boolean>) | undefined;
    let onCleanup: ((pr: number) => Promise<void>) | undefined;
    let onChecks: ((pr: PullRequestObservation, signal: AbortSignal) => Promise<{ headSha: string; baseRef: string; ready: boolean }>) | undefined;
    const client: GitHubClient = {
      resolveRepository: async (config) => identities[configurations.findIndex((item) => item.name === config.name)]!,
      listPullRequestNumbers: async () => [],
      listOpenPullRequests: async (repository) => {
        const index = identities.findIndex((item) => item.githubId === repository.githubId);
        polls[index]!++;
        await onPoll?.(index);
        return [...snapshots[index]!.values()].filter((item) => item.state === "open").map((item) => ({ ...item }));
      },
      getPullRequest: async (repository, number) => ({ ...snapshots[identities.findIndex((item) => item.githubId === repository.githubId)]!.get(number)! }),
      getPullRequestReviewSnapshot: async (repository, number) => {
        await onSnapshot?.();
        const pr = snapshots[identities.findIndex((item) => item.githubId === repository.githubId)]!.get(number)!;
        return { state: pr.state, draft: pr.draft, headSha: pr.headSha, baseRef: pr.baseRef, viewerId: "viewer", reviews: publications.filter((item) => item.body.includes(`number=${number} `)), threads: [...threads] };
      },
      getPullRequestChecks: async (repository, number, signal) => {
        const pr = { ...snapshots[identities.findIndex((item) => item.githubId === repository.githubId)]!.get(number)! };
        checked.push({ number, headSha: pr.headSha, baseRef: pr.baseRef });
        return onChecks === undefined ? { headSha: pr.headSha, baseRef: pr.baseRef, ready: pr.state === "open" && !pr.draft } : onChecks(pr, signal!);
      },
    };
    const git: CoordinatorOptions["git"] = {
      ensureRepository: async (config) => locals[configurations.findIndex((item) => item.name === config.name)]!,
      prepareWorktree: async (state, local, id, excluded, signal) => {
        expect(excluded.processesExcluded).toBe(true);
        const review = state.getReview(id)!;
        prepared.push(review);
        await onPrepare?.(review, signal!);
        signal?.throwIfAborted();
        const target = path.join(local.root, ".worktrees", `pr-${review.number}`);
        state.registerWorktree(review, target);
        state.pinReviewBase(id, state.getPullRequest(review)!.baseSha, Date.now());
        return { kind: "prepared", path: target, headSha: review.headSha, baseSha: state.getReview(id)!.baseSha!, mergeBaseSha: "c".repeat(40), gitEnvironment: {} };
      },
      cleanupWorktree: async (state, local, pr, excluded) => {
        expect(excluded).toEqual(proof);
        cleaned.push(pr.number);
        await onCleanup?.(pr.number);
        const current = state.getPullRequest(pr)!;
        if (current.state === "open") {
          state.cancelCleanup(pr, current.worktreePath!, excluded);
          return { kind: "reopened" };
        }
        state.completeCleanup(pr, current.worktreePath!, excluded);
        return { kind: "cleaned" };
      },
    };
    const runner: CoordinatorOptions["runner"] = { run: async (state, id, worktree, input) => {
      const started = state.startAttempt(id, { processOwner: "fixture", stdoutLogPath: path.join(directory, `${id}-out`), stderrLogPath: path.join(directory, `${id}-err`) }, Date.now());
      launched.push({ review: started, session: state.getPullRequest(started)!.sessionId!, input });
      const completed = onRun === undefined ? true : await onRun(started, input);
      const outcome: CopilotAttemptOutcome = { attempt: { reviewId: id, attempt: started.attemptCount }, sessionId: state.getPullRequest(started)!.sessionId!, sessionMode: started.attemptCount === 1 ? "create" : "resume",
        stdoutLogPath: started.stdoutLogPath!, stderrLogPath: started.stderrLogPath!, completed, directProcessClosed: true, captureComplete: true,
        exitCode: 0, signal: null, lastNonemptyLine: completed ? `PR ${started.number} Review Completed` : "incomplete", interruption: null, launchFailure: null, processExclusionFailure: null, errors: [] };
      if (completed && !publications.some((item) => item.body.includes(`review=${id} `))) publications.push({ id: `remote-${id}`, authorId: "viewer", headSha: started.headSha,
        state: "APPROVED", body: `number=${started.number} fixture\n<!-- daynight review=${id} revision=${started.revision} head=${started.headSha} -->` });
      expect(worktree.headSha).toBe(started.headSha);
      return outcome;
    } };
    const processes: CoordinatorOptions["processes"] = { onProcess: () => {}, stop: async () => {}, exclude: async () => proof, recover: async () => proof };
    const configuration = { pollIntervalMs: 20, maxConcurrentWorker: 1, agentTimeoutMs: 10_000, maxAttempts: 3, retryDelayMs: 20, repositories: configurations };
    const runs: { abort: AbortController; completion: Promise<{ safeToReleaseLock: boolean }> }[] = [];
    const start = (overrides: Partial<CoordinatorOptions> = {}) => {
      const abort = new AbortController();
      const completion = runCoordinator({ configuration, store, client, git, runner, processes, signal: abort.signal, log: (event) => { events.push(event); }, ...overrides });
      const run = { abort, completion };
      runs.push(run);
      return run;
    };
    const update = (number: number, change: Partial<PullRequestObservation> = {}, index = 0) => {
      snapshots[index]!.set(number, observation(number, { ...snapshots[index]!.get(number), ...change }));
    };
    const pr = (number = 1, index = 0) => ({ ...identities[index]!, number });
    const migrateSchema1 = () => {
      store.close();
      const previous = new Database(paths.databaseFile);
      try { previous.exec("DROP TABLE review_publications; PRAGMA user_version = 1"); } finally { previous.close(); }
      store = openStore(paths.databaseFile);
    };
    const result = { directory, paths, get store() { return store; }, migrateSchema1, publications, threads, snapshot: (handler: typeof onSnapshot) => { onSnapshot = handler; }, configurations, identities, snapshots, polls, events, prepared, launched, cleaned, checked, client, git, runner, processes, configuration, start, update, pr, runs,
      prepare: (handler: typeof onPrepare) => { onPrepare = handler; }, run: (handler: typeof onRun) => { onRun = handler; }, poll: (handler: typeof onPoll) => { onPoll = handler; }, cleanup: (handler: typeof onCleanup) => { onCleanup = handler; },
      checks: (handler: typeof onChecks) => { onChecks = handler; } };
    fixtures.push(result);
    return result;
  };

  afterEach(async () => {
    for (const f of fixtures.splice(0)) {
      for (const run of f.runs) run.abort.abort(new Error("Test shutdown."));
      await Promise.all(f.runs.map((run) => run.completion));
      f.store.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  return { proof, uuid, deferred, waitFor, untilAborted, observation, fixture };
};
