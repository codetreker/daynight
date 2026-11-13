CREATE INDEX tasks_personal_in_progress
ON tasks (assigned_to, project_id, started_at DESC NULLS LAST, id)
WHERE type='task' AND status='in_progress' AND deleted_at IS NULL;
