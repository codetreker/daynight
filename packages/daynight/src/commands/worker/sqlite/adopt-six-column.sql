ALTER TABLE tasks RENAME TO legacy_tasks;
DROP INDEX tasks_one_active_per_task;

CREATE TABLE tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'done')),
  agent TEXT NOT NULL CHECK(agent IN ('copilot', 'codex', 'claude')),
  session_id TEXT,
  agent_control_mode TEXT NOT NULL DEFAULT 'herdr' CHECK(agent_control_mode IN ('herdr', 'web')),
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT;

CREATE UNIQUE INDEX tasks_one_active_per_task ON tasks(project_id, task_id) WHERE status = 'active';

INSERT INTO tasks(project_id, task_id, claim_id, status, agent, session_id)
SELECT project_id, task_id, claim_id, status, agent, session_id FROM legacy_tasks;

DROP TABLE legacy_tasks;
