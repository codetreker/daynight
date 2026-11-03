ALTER TABLE tasks ADD COLUMN assigned_to uuid;

CREATE INDEX tasks_project_assigned_to_created_id
ON tasks (project_id, assigned_to, created_at, id)
WHERE deleted_at IS NULL;
