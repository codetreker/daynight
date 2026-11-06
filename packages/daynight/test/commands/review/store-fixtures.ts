import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, vi } from "vitest";
import { openStore, type Store } from "../../../src/commands/review/store.js";
import type { PullRequestObservation, ReviewState } from "../../../src/commands/review/model.js";

import { createMemoryDatabase } from "../../helpers/sqlite.js";
import type { SqliteDatabaseSource } from "../../../src/platform/sqlite-access.js";

export const createReviewStoreFixtures = (memory: boolean) => {
  const fixtures = path.resolve(import.meta.dirname, "../../../../../.tmp/store-tests");
  const directories: string[] = [];
  const stores = new Set<Store>();
  const schemaV1 = readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8");
  const connections = new Set<Database.Database>();
  const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
  const repository = { host: "github.com", githubId: "42" };
  const pr = { ...repository, number: 101 };
  const stopped = { operationsStopped: true, processesExcluded: true } as const;

  const connect = (file: SqliteDatabaseSource): Database.Database => {
    const connection = typeof file === "string" ? new Database(file) : file;
    connections.add(connection);
    return connection;
  };
  const open = (file: SqliteDatabaseSource, options?: { busyTimeoutMs?: number }): Store => {
    const store = openStore(file, { ...options, onMigration: () => {} });
    stores.add(store);
    return store;
  };
  const close = (store: Store): void => { store.close(); stores.delete(store); };
  const fixture = () => {
    mkdirSync(fixtures, { recursive: true });
    const directory = mkdtempSync(path.join(fixtures, "SQLite 用户 "));
    directories.push(directory);
    const file = memory ? createMemoryDatabase() : path.join(directory, "state.sqlite");
    const store = open(file);
    let nextId = 1;
    const register = (target = repository) => store.registerRepository({ ...target, remote: "https://github.com/owner/repo.git", localPath: path.join(directory, "repo") });
    const initialize = (cutoff = 100) => { register(); return store.initializeRepository(repository, cutoff, 10); };
    const observe = (overrides: Partial<PullRequestObservation> = {}, now = 20) => store.observePullRequest(repository, {
      number: 101, state: "open", draft: false, headSha: "head-a", baseRef: "main", baseSha: "base-a", ...overrides,
    }, now);
    const reserve = (maxAttempts = 3, now = 30): ReviewState => {
      const review = store.reserveReview(pr, { reviewId: uuid(nextId++), sessionId: uuid(500), maxAttempts }, now);
      if (review === null) throw new Error("Expected a review reservation.");
      return review;
    };
    const prepare = (review: ReviewState): void => {
      store.registerWorktree(pr, path.join(directory, "repo", ".worktrees", "pr-101"));
      store.pinReviewBase(review.id, "pinned-base", 35);
    };
    const launch = (review: ReviewState, now = 40): ReviewState => store.startAttempt(review.id, {
      processOwner: uuid(700), stdoutLogPath: path.join(directory, "logs", review.id, String(review.attemptCount + 1), "stdout.log"),
      stderrLogPath: path.join(directory, "logs", review.id, String(review.attemptCount + 1), "stderr.log"),
    }, now);
    return { directory, file, store, register, initialize, observe, reserve, prepare, launch };
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) store.close();
    stores.clear();
    for (const connection of connections) if (connection.open) connection.close();
    connections.clear();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });

  return { fixtures, directories, uuid, repository, pr, stopped, connect, open, close, fixture, schemaV1 };
};
