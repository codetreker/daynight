CREATE TABLE tasks (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    title text NOT NULL CHECK (btrim(title) <> ''),
    description text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX tasks_project_created_id ON tasks (project_id, created_at, id);
CREATE INDEX tasks_project_status_created_id ON tasks (project_id, status, created_at, id);

CREATE TABLE task_dependencies (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    depends_on_task_id uuid NOT NULL,
    PRIMARY KEY (project_id, task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX task_dependencies_predecessor ON task_dependencies (project_id, depends_on_task_id, task_id);
