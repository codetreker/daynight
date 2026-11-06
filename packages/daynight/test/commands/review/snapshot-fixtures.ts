import path from "node:path";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, vi } from "vitest";
import { openStore, readReviewListingSnapshot, type Store } from "../../../src/commands/review/store.js";
import type { PullRequestObservation, ReviewState } from "../../../src/commands/review/model.js";

import { createMemoryDatabase } from "../../helpers/sqlite.js";
import type { SqliteDatabaseSource } from "../../../src/platform/sqlite-access.js";

export const createReviewSnapshotFixtures = (memory: boolean) => {
  const fixtureRoot = path.resolve(import.meta.dirname, "../../../../../.tmp/store-snapshot-tests");
  const directories: string[] = [];
  const stores = new Set<Store>();
  const connections = new Set<Database.Database>();
  const repository = { host: "github.com", githubId: "42" };
  const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
  const excluded = { processesExcluded: true } as const;
  const readSnapshot = (databaseFile: SqliteDatabaseSource) => readReviewListingSnapshot({
    databaseFile, lockFile: path.join(typeof databaseFile === "string" ? path.dirname(databaseFile) : fixtureRoot, "instance.lock"),
  }, { onMigration: () => {} });
  const schemaV1 = readFileSync(new URL("./fixtures/schema-v1.sql", import.meta.url), "utf8");
  const causeTree = (error: unknown): unknown[] => {
    if (!(error instanceof Error)) return [error];
    return [error, ...(error.cause === undefined ? [] : causeTree(error.cause)), ...(error instanceof AggregateError ? error.errors.flatMap(causeTree) : [])];
  };

  const directory = (): string => {
    mkdirSync(fixtureRoot, { recursive: true });
    const result = mkdtempSync(path.join(fixtureRoot, "snapshot 用户 "));
    directories.push(result);
    return result;
  };
  const connect = (file: SqliteDatabaseSource): Database.Database => {
    const db = typeof file === "string" ? new Database(file) : file;
    connections.add(db);
    return db;
  };
  const fixture = () => {
    const location = directory();
    const file = memory ? createMemoryDatabase() : path.join(location, "state.sqlite");
    const store = openStore(file, { onMigration: () => {} });
    stores.add(store);
    store.registerRepository({ ...repository, remote: "https://github.com/owner/repo.git", localPath: path.join(location, "repo") });
    store.applyRepositoryPoll(repository, { kind: "initialize", startPrNumber: 100 }, 10);
    let nextId = 1;
    const observe = (number = 101, overrides: Partial<PullRequestObservation> = {}, now = 20) => store.observePullRequest(repository, {
      number, state: "open", draft: false, headSha: `head-${number}`, baseRef: "main", baseSha: "observed-base", ...overrides,
    }, now);
    const reserve = (number = 101, maxAttempts = 3): ReviewState => {
      const review = store.reserveReview({ ...repository, number }, { reviewId: uuid(nextId++), sessionId: uuid(500 + number), maxAttempts }, 30);
      if (review === null) throw new Error("Expected a review reservation.");
      return review;
    };
    const launch = (review: ReviewState): ReviewState => {
      store.registerWorktree(review, path.join(location, `pr-${review.number}`));
      store.pinReviewBase(review.id, "pinned-base", 35);
      return store.startAttempt(review.id, {
        processOwner: uuid(900), stdoutLogPath: path.join(location, "stdout.log"), stderrLogPath: path.join(location, "stderr.log"),
      }, 40);
    };
    return { location, file, store, observe, reserve, launch };
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(lstatSync).mockReset();
    for (const store of stores) store.close();
    stores.clear();
    for (const db of connections) if (db.open) db.close();
    connections.clear();
    for (const location of directories.splice(0)) rmSync(location, { recursive: true });
  });

  return { repository, uuid, excluded, readSnapshot, schemaV1, causeTree, directory, connect, fixture };
};
