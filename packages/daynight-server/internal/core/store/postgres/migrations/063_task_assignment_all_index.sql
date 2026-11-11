CREATE INDEX tasks_project_assigned_to_created_id_all
ON tasks (project_id, assigned_to, created_at, id);
