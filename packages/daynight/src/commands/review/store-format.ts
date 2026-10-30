import type Database from "better-sqlite3";
import type { SqliteFormat } from "../../platform/sqlite-format.js";

type SchemaObject = { name: string; type: string; sql: string };

const baselineObjects: readonly SchemaObject[] = [
  { name: "repositories", type: "table", sql: `CREATE TABLE repositories (
    host TEXT NOT NULL,
    github_id TEXT NOT NULL,
    remote TEXT NOT NULL,
    local_path TEXT NOT NULL,
    start_pr_no INTEGER CHECK(start_pr_no >= 0),
    initialized_at INTEGER,
    last_poll_at INTEGER,
    last_poll_error TEXT,
    PRIMARY KEY(host, github_id),
    CHECK((start_pr_no IS NULL) = (initialized_at IS NULL))
  ) STRICT` },
  { name: "pull_requests", type: "table", sql: `CREATE TABLE pull_requests (
    host TEXT NOT NULL,
    github_id TEXT NOT NULL,
    number INTEGER NOT NULL CHECK(number > 0),
    state TEXT NOT NULL CHECK(state IN ('open', 'closed', 'merged')),
    draft INTEGER NOT NULL CHECK(draft IN (0, 1)),
    head_sha TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    desired_revision INTEGER NOT NULL CHECK(desired_revision > 0),
    completed_revision INTEGER NOT NULL DEFAULT 0 CHECK(completed_revision >= 0 AND completed_revision <= desired_revision),
    session_id TEXT,
    session_established INTEGER NOT NULL DEFAULT 0 CHECK(session_established IN (0, 1)),
    worktree_path TEXT,
    cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0, 1)),
    cleanup_error TEXT,
    observed_at INTEGER NOT NULL,
    PRIMARY KEY(host, github_id, number),
    CHECK(session_established = 0 OR session_id IS NOT NULL),
    CHECK(cleanup_pending = 0 OR worktree_path IS NOT NULL)
  ) STRICT` },
  { name: "reviews", type: "table", sql: `CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    host TEXT NOT NULL,
    github_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    head_sha TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    base_sha TEXT,
    status TEXT NOT NULL CHECK(status IN ('preparing', 'running', 'retry_wait', 'completed', 'failed', 'interrupted', 'superseded')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK(max_attempts > 0 AND attempt_count <= max_attempts),
    retry_at INTEGER,
    process_owner TEXT,
    process_id INTEGER,
    process_identity TEXT,
    stdout_log_path TEXT,
    stderr_log_path TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((status = 'retry_wait') = (retry_at IS NOT NULL)),
    CHECK(status <> 'running' OR (base_sha IS NOT NULL AND attempt_count > 0 AND process_owner IS NOT NULL AND stdout_log_path IS NOT NULL AND stderr_log_path IS NOT NULL)),
    CHECK((process_id IS NULL) = (process_identity IS NULL))
  ) STRICT` },
  { name: "reviews_one_active_per_pr", type: "index", sql: `CREATE UNIQUE INDEX reviews_one_active_per_pr ON reviews(host, github_id, number)
    WHERE status IN ('preparing', 'running', 'retry_wait', 'interrupted')` },
  { name: "reviews_revision", type: "index", sql: `CREATE INDEX reviews_revision ON reviews(host, github_id, number, revision)` },
];
const publicationObject: SchemaObject = {
  name: "review_publications", type: "table", sql: `CREATE TABLE review_publications (
    review_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL CHECK(phase IN ('prepared', 'pending', 'verified', 'legacy')),
    identity_format TEXT NOT NULL DEFAULT 'line' CHECK(identity_format IN ('line', 'legacy')),
    publisher_id TEXT CHECK(phase = 'legacy' OR identity_format = 'legacy' OR publisher_id IS NOT NULL),
    outcome TEXT CHECK(outcome IN ('approved', 'commented')),
    remote_review_id TEXT,
    remote_thread_ids TEXT NOT NULL DEFAULT '[]',
    followup_consumed INTEGER NOT NULL DEFAULT 0 CHECK(followup_consumed IN (0, 1)),
    CHECK((phase = 'verified') = (outcome IS NOT NULL AND remote_review_id IS NOT NULL))
  ) STRICT`,
};

const sqlTokens = (sql: string): string => {
  const tokens = sql.match(/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[^\s]/g);
  if (tokens === null) throw new Error("Review schema contains an empty SQL definition.");
  const normalized = tokens.filter(token => !token.startsWith("--") && !token.startsWith("/*"))
    .map(token => /^[A-Za-z_]/.test(token) ? token.toLowerCase() : token);
  if (normalized.at(-1) === ";") normalized.pop();
  return JSON.stringify(normalized);
};

const validateReviewVersion = (db: Database.Database, version: number): undefined => {
  if (version !== 1 && version !== 2) throw new Error(`Unsupported Review schema version ${version}.`);
  const expected = [...baselineObjects, ...(version === 2 ? [publicationObject] : [])].sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
  const actual = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all() as SchemaObject[];
  if (actual.length !== expected.length || actual.some((object, index) => {
    const definition = expected[index]!;
    return object.name !== definition.name || object.type !== definition.type || sqlTokens(object.sql) !== sqlTokens(definition.sql);
  })) throw new Error(`Review SQLite structure does not match schema version ${version}.`);
};

export const reviewFormat: SqliteFormat = {
  name: "Review",
  baseline: {
    version: 1,
    create: db => { for (const object of baselineObjects) db.exec(object.sql); },
  },
  migrations: [{
    toVersion: 2,
    up: db => {
      db.exec(publicationObject.sql);
      db.exec(`INSERT INTO review_publications(review_id, phase, identity_format)
        SELECT id, CASE WHEN status = 'completed' THEN 'legacy' ELSE 'prepared' END, 'legacy'
        FROM reviews WHERE status = 'completed' OR status IN ('preparing', 'running', 'retry_wait', 'interrupted')`);
    },
  }],
  validateVersioned: validateReviewVersion,
};
