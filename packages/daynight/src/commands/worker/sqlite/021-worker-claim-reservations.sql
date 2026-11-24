DROP TABLE lifecycle_adoption;

-- Each versioned claim attempt retains its original selection until the
-- server identifies the winner or advances the Task beyond that attempt.
ALTER TABLE claim_tool_reservations RENAME TO old_claim_tool_reservations;

CREATE TABLE claim_tool_reservations (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  agent_control_mode TEXT NOT NULL CHECK(agent_control_mode IN ('web', 'herdr')),
  configuration TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT;

INSERT INTO claim_tool_reservations SELECT * FROM old_claim_tool_reservations;
DROP TABLE old_claim_tool_reservations;
