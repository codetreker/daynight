CREATE TABLE cleanup_schedules (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  deadline INTEGER NOT NULL CHECK(deadline BETWEEN 0 AND 9007199254740991),
  notified INTEGER NOT NULL CHECK(notified IN (0, 1)),
  submitted INTEGER NOT NULL CHECK(submitted IN (0, 1) AND submitted <= notified),
  failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 9007199254740991),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at BETWEEN 0 AND 9007199254740991),
  stage TEXT NOT NULL CHECK(length(trim(stage)) > 0),
  last_error TEXT,
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT;
