ALTER TABLE archive_backfill_schedules RENAME TO previous_archive_backfill_schedules;
CREATE TABLE archive_backfill_schedules (
  server_origin TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  archive_repair_code TEXT CHECK(archive_repair_code IN ('archive_incomplete', 'projection_gap', 'markdown_projection_failed')),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at >= 0),
  legacy_error TEXT,
  PRIMARY KEY(server_origin, execution_id)
) STRICT;
INSERT INTO archive_backfill_schedules(server_origin, execution_id, execution_generation, launch_id, project_id, task_id, claim_id, archive_repair_code, next_attempt_at)
SELECT server_origin, execution_id, execution_generation, launch_id, project_id, task_id, claim_id, archive_repair_code, next_attempt_at FROM previous_archive_backfill_schedules;
DROP TABLE previous_archive_backfill_schedules;
