ALTER TABLE cleanup_schedules ADD COLUMN archive_repair_code TEXT CHECK(archive_repair_code IN ('archive_incomplete', 'projection_gap'));

-- Historical catch-up is not a worktree cleanup responsibility.
CREATE TABLE archive_backfill_schedules (
  server_origin TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  archive_repair_code TEXT NOT NULL CHECK(archive_repair_code IN ('archive_incomplete', 'projection_gap')),
  next_attempt_at INTEGER NOT NULL CHECK(next_attempt_at >= 0),
  PRIMARY KEY(server_origin, execution_id)
) STRICT;
