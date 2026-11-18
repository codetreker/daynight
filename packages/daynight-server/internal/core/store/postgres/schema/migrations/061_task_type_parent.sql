ALTER TABLE tasks ADD COLUMN type text NOT NULL DEFAULT 'task';
ALTER TABLE tasks ADD COLUMN parent_id uuid;

CREATE INDEX tasks_project_type_created_id ON tasks (project_id, type, created_at, id);
CREATE INDEX tasks_project_parent_created_id ON tasks (project_id, parent_id, created_at, id);
