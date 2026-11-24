CREATE INDEX tasks_project_effective_deleted_id ON tasks
 (project_id, (COALESCE(deleted_at, ancestor_deleted_at)), id)
 WHERE COALESCE(deleted_at, ancestor_deleted_at) IS NOT NULL;
