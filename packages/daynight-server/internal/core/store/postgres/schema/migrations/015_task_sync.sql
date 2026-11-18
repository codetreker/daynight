ALTER TABLE projects ADD COLUMN task_cache_epoch uuid NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX tasks_project_updated_id ON tasks (project_id, updated_at, id);
