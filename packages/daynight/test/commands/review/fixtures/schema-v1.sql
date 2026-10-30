CREATE TABLE repositories (
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
  ) STRICT;
  CREATE TABLE pull_requests (
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
  ) STRICT;
  CREATE TABLE reviews (
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
  ) STRICT;
  CREATE UNIQUE INDEX reviews_one_active_per_pr ON reviews(host, github_id, number)
    WHERE status IN ('preparing', 'running', 'retry_wait', 'interrupted');
  CREATE INDEX reviews_revision ON reviews(host, github_id, number, revision);
PRAGMA user_version = 1;
