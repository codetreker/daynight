CREATE TABLE cleanup_schedules_markdown (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  deadline INTEGER NOT NULL CHECK(deadline BETWEEN 0 AND 9007199254740991),
  failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 9007199254740991),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at BETWEEN 0 AND 9007199254740991),
  stage TEXT NOT NULL CHECK(length(trim(stage)) > 0),
  last_error TEXT,
  archive_repair_code TEXT CHECK(archive_repair_code IN ('archive_incomplete', 'projection_gap', 'markdown_projection_failed')),
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT;
INSERT INTO cleanup_schedules_markdown SELECT * FROM cleanup_schedules;
DROP TABLE cleanup_schedules;
ALTER TABLE cleanup_schedules_markdown RENAME TO cleanup_schedules;

CREATE TABLE archive_backfill_schedules_markdown (
  server_origin TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  archive_repair_code TEXT NOT NULL CHECK(archive_repair_code IN ('archive_incomplete', 'projection_gap', 'markdown_projection_failed')),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at >= 0),
  PRIMARY KEY(server_origin, execution_id)
) STRICT;
INSERT INTO archive_backfill_schedules_markdown SELECT * FROM archive_backfill_schedules;
DROP TABLE archive_backfill_schedules;
ALTER TABLE archive_backfill_schedules_markdown RENAME TO archive_backfill_schedules;
