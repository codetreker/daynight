ALTER TABLE projects ADD COLUMN deleted_at timestamptz;

CREATE INDEX projects_live_created_id_idx ON projects (created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX tasks_project_id_id_idx ON tasks (project_id, id);
CREATE INDEX task_sessions_project_id_id_task_idx ON task_sessions (project_id, id) WHERE scope = 'task';
