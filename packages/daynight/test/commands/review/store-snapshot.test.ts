import path from "node:path";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireInstanceLock } from "../../../src/commands/review/runtime.js";
import { openStore, readReviewListingSnapshot, type Store } from "../../../src/commands/review/store.js";
import { SqliteAccessError } from "../../../src/platform/sqlite-error.js";
import type { PullRequestObservation, ReviewState } from "../../../src/commands/review/model.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const fixtureRoot = path.resolve(import.meta.dirname, "../../../../../.tmp/store-snapshot-tests");
const directories: string[] = [];
const stores = new Set<Store>();
const connections = new Set<Database.Database>();
const repository = { host: "github.com", githubId: "42" };
const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const excluded = { processesExcluded: true } as const;
const readSnapshot = (databaseFile: string) => readReviewListingSnapshot({
  databaseFile, lockFile: path.join(path.dirname(databaseFile), "instance.lock"),
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
const connect = (file: string): Database.Database => {
  const db = new Database(file);
  connections.add(db);
  return db;
};
const fixture = () => {
  const location = directory();
  const file = path.join(location, "state.sqlite");
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

describe("review listing snapshots and automatic upgrades", () => {
  it("returns null for a missing database without creating files or directories", () => {
    const location = directory();
    expect(readSnapshot(path.join(location, "state.sqlite"))).toBeNull();
    expect(readSnapshot(path.join(location, "missing", "state.sqlite"))).toBeNull();
    expect(readdirSync(location)).toEqual([]);
    expect(() => readSnapshot("state.sqlite")).toThrow("must be absolute");
  });

  it("propagates a filesystem failure rather than reporting an absent database", () => {
    const location = directory();
    const file = path.join(location, "file");
    writeFileSync(file, "occupied");
    expect(() => readSnapshot(path.join(file, "state.sqlite"))).toThrow();
    expect(() => readSnapshot(location)).toThrow();
  });

  it("rejects a file ancestor when the host reports Windows-style ENOENT", () => {
    const location = directory();
    const file = path.join(location, "file");
    const databaseFile = path.join(file, "state.sqlite");
    writeFileSync(file, "occupied");
    vi.mocked(lstatSync).mockImplementationOnce((target) => {
      expect(target).toBe(databaseFile);
      throw Object.assign(new Error("Windows reports a missing path below a file"), { code: "ENOENT" });
    });
    let failure: unknown;
    try { readSnapshot(databaseFile); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SqliteAccessError);
    expect(failure).toMatchObject({
      kind: "migration-failed", context: { database: "Review", phase: "inspect-path", file: databaseFile },
    });
    expect((failure as SqliteAccessError).cause).toBeInstanceOf(Error);
    expect(((failure as SqliteAccessError).cause as Error).message).toContain("ancestor is not a directory");
    expect(vi.mocked(lstatSync).mock.calls.map(([target]) => target)).toEqual([databaseFile, file]);
  });

  it("distinguishes a missing database through a valid directory link from a broken link", () => {
    const location = directory();
    const target = path.join(location, "target");
    const validLink = path.join(location, "valid-link");
    const brokenLink = path.join(location, "broken-link");
    mkdirSync(target);
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(target, validLink, linkType);
    symlinkSync(path.join(location, "absent-target"), brokenLink, linkType);
    expect(readSnapshot(path.join(validLink, "missing", "state.sqlite"))).toBeNull();
    expect(() => readSnapshot(path.join(brokenLink, "state.sqlite"))).toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it("propagates an unavailable filesystem root and permission errors", () => {
    const location = directory();
    const databaseFile = path.join(location, "state.sqlite");
    const rootError = Object.assign(new Error("filesystem root is unavailable"), { code: "ENOENT" });
    vi.mocked(lstatSync).mockImplementation(() => { throw rootError; });
    let rootFailure: unknown;
    try { readSnapshot(databaseFile); } catch (error) { rootFailure = error; }
    expect(rootFailure).toBeInstanceOf(SqliteAccessError);
    expect(rootFailure).toMatchObject({
      kind: "migration-failed", context: { database: "Review", phase: "inspect-path", file: databaseFile },
    });
    expect((rootFailure as SqliteAccessError).cause).toBe(rootError);
    expect((rootFailure as SqliteAccessError).cause).toMatchObject({ code: "ENOENT" });
    expect(vi.mocked(lstatSync).mock.calls.at(-1)?.[0]).toBe(path.parse(databaseFile).root);
    const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.mocked(lstatSync).mockImplementation(() => { throw permissionError; });
    let permissionFailure: unknown;
    try { readSnapshot(databaseFile); } catch (error) { permissionFailure = error; }
    expect(permissionFailure).toBeInstanceOf(SqliteAccessError);
    expect(permissionFailure).toMatchObject({
      kind: "migration-failed", context: { database: "Review", phase: "inspect-path", file: databaseFile },
    });
    expect((permissionFailure as SqliteAccessError).cause).toBe(permissionError);
    expect((permissionFailure as SqliteAccessError).cause).toMatchObject({ code: "EACCES" });
    expect(readdirSync(location)).toEqual([]);
  });

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

  it("reads the last commit while a WAL writer has an uncommitted transaction and an instance lock", async () => {
    const { location, file, store, observe, reserve } = fixture();
    observe();
    reserve();
    const lock = await acquireInstanceLock(path.join(location, "instance.lock"), "active-writer");
    const writer = connect(file);
    writer.exec("BEGIN IMMEDIATE");
    try {
      writer.exec("UPDATE repositories SET last_poll_at = 999; UPDATE pull_requests SET head_sha = 'uncommitted-head', desired_revision = 2; UPDATE reviews SET last_error = 'uncommitted-error'");
      const snapshot = readSnapshot(file);
      expect(snapshot?.repositories[0]?.lastPollAt).toBe(10);
      expect(snapshot?.pullRequests[0]?.headSha).toBe("head-101");
      expect(snapshot?.reviews[0]?.lastError).toBeNull();
      expect(store.getPullRequest({ ...repository, number: 101 })?.desiredRevision).toBe(1);
    } finally {
      writer.exec("ROLLBACK");
      await lock.release();
    }
  });

  it("keeps repository, PR and review reads in one snapshot when a writer commits between SELECTs", () => {
    const { file, store, observe, reserve } = fixture();
    observe();
    const preparing = reserve();
    const originalPrepare = Database.prototype.prepare;
    let committed = false;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (!this.readonly || !sql.includes("FROM repositories ORDER BY")) return statement;
      const all = statement.all.bind(statement) as () => unknown[];
      vi.spyOn(statement, "all").mockImplementation(() => {
        const rows = all();
        if (!committed) {
          committed = true;
          store.applyRepositoryPoll(repository, { kind: "snapshot", observations: [{
            number: 101, state: "open", draft: false, headSha: "committed-head", baseRef: "release", baseSha: "committed-base",
          }] }, 100);
          store.supersedeReview(preparing.id, { operationsStopped: true }, 101);
        }
        return rows;
      });
      return statement;
    });
    const snapshot = readSnapshot(file);
    expect(committed).toBe(true);
    expect(store.getRepository(repository)?.lastPollAt).toBe(100);
    expect(store.getReview(preparing.id)?.status).toBe("superseded");
    expect(snapshot?.repositories[0]?.lastPollAt).toBe(10);
    expect(snapshot?.pullRequests[0]).toMatchObject({ headSha: "head-101", baseRef: "main", desiredRevision: 1 });
    expect(snapshot?.reviews[0]).toMatchObject({ id: preparing.id, status: "preparing" });
  });

  it("automatically upgrades an independent schema1 fixture and keeps the original listing records", () => {
    const location = directory();
    const file = path.join(location, "state.sqlite");
    const sql = connect(file);
    sql.exec(schemaV1);
    sql.exec(`INSERT INTO repositories VALUES ('github.com','42','https://github.com/owner/repo.git','/repo',100,10,20,NULL);
      INSERT INTO pull_requests(host,github_id,number,state,draft,head_sha,base_ref,base_sha,desired_revision,observed_at)
        VALUES('github.com','42',101,'open',0,'head','main','base',1,20);
      INSERT INTO reviews(id,host,github_id,number,revision,head_sha,base_ref,status,max_attempts,created_at,updated_at)
        VALUES('original-review','github.com','42',101,1,'head','main','preparing',3,20,20)`);
    const snapshot = readSnapshot(file);
    expect(snapshot?.pullRequests[0]).toMatchObject({ number: 101, headSha: "head" });
    expect(snapshot?.reviews[0]).toMatchObject({ id: "original-review", status: "preparing" });
    expect(sql.pragma("user_version", { simple: true })).toBe(2);
    expect(sql.prepare("SELECT phase, identity_format, publisher_id FROM review_publications").all()).toEqual([
      { phase: "prepared", identity_format: "legacy", publisher_id: null },
    ]);
    expect(existsSync(path.join(location, "instance.lock"))).toBe(false);
  });

  it.each(["active", "dead", "invalid"] as const)("preserves a %s predecessor instance lock while an old format requires migration", (kind) => {
    const location = directory();
    const file = path.join(location, "state.sqlite");
    const sql = connect(file); sql.exec(schemaV1);
    const lockFile = path.join(location, "instance.lock");
    const lock = kind === "invalid" ? "unreadable predecessor metadata" : JSON.stringify({ owner: "original-owner", pid: kind === "active" ? process.pid : 2147483647, startedAt: new Date(0).toISOString() });
    writeFileSync(lockFile, lock);
    let failure: unknown;
    try { readSnapshot(file); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SqliteAccessError);
    expect((failure as SqliteAccessError).kind).toBe("upgrade-blocked");
    expect(readFileSync(lockFile, "utf8")).toBe(lock);
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
    expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name='review_publications'").get()).toBeUndefined();
  });

  it.each(["missing active index", "changed state constraint"] as const)("rejects schema1 with a %s before attempting migration", (alteration) => {
    const file = path.join(directory(), "state.sqlite");
    const sql = connect(file);
    sql.exec(alteration === "changed state constraint" ? schemaV1.replace("('open', 'closed', 'merged')", "('OPEN', 'closed', 'merged')") : schemaV1);
    if (alteration === "missing active index") sql.exec("DROP INDEX reviews_one_active_per_pr");
    expect(() => readSnapshot(file)).toThrow("invalid-format");
    expect(sql.pragma("user_version", { simple: true })).toBe(1);
    expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name='review_publications'").get()).toBeUndefined();
  });

  it("does not mistake an unrecognized sqlite-prefixed user index for an internal object", () => {
    const { file } = fixture();
    const sql = connect(file); sql.exec("CREATE INDEX sqliteXcustom ON reviews(id)");
    expect(() => readSnapshot(file)).toThrow("invalid-format");
    expect(sql.prepare("SELECT name FROM sqlite_schema WHERE name='sqliteXcustom'").get()).toEqual({ name: "sqliteXcustom" });
  });

  it.each([0, 3])("rejects existing schema version %i without migration and closes the reader", (version) => {
    const file = path.join(directory(), "state.sqlite");
    const sql = connect(file);
    sql.pragma(`user_version = ${version}`);
    sql.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')");
    const close = vi.spyOn(Database.prototype, "close");
    expect(() => readSnapshot(file)).toThrow(SqliteAccessError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(sql.pragma("user_version", { simple: true })).toBe(version);
    expect(sql.prepare("SELECT value FROM sentinel").get()).toEqual({ value: "preserved" });
    expect(sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "sentinel" }]);
  });

  it("exposes corruption and closes its connection", () => {
    const file = path.join(directory(), "state.sqlite");
    writeFileSync(file, "This is not a SQLite database.");
    const close = vi.spyOn(Database.prototype, "close");
    let failure: unknown;
    try { readSnapshot(file); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SqliteAccessError);
    expect(causeTree(failure).some(error => error instanceof Error && error.message.includes("not a database"))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves the operation error when connection cleanup also fails: %s", (failOperation) => {
    const { file } = fixture();
    if (failOperation) connect(file).pragma("user_version = 3");
    const cleanupError = new Error("reader cleanup failed");
    const originalClose = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      originalClose.call(this);
      if (this.readonly) throw cleanupError;
      return this;
    });
    if (!failOperation) {
      let failure: unknown;
      try { readSnapshot(file); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(SqliteAccessError);
      expect(causeTree(failure)).toContain(cleanupError);
    } else {
      let error: unknown;
      try { readSnapshot(file); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(SqliteAccessError);
      const causes = causeTree(error);
      expect(causes.some(cause => cause instanceof SqliteAccessError && cause.kind === "unsupported-version")).toBe(true);
      expect(causes).toContain(cleanupError);
    }
  });
});
