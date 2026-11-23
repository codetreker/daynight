-- A claim request keeps its original tools before any grant is confirmed.
-- It is not a local execution and must survive an unknown HTTP outcome.
CREATE TABLE claim_tool_reservations (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  agent_control_mode TEXT NOT NULL CHECK(agent_control_mode IN ('web', 'herdr')),
  configuration TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id)
) STRICT;
