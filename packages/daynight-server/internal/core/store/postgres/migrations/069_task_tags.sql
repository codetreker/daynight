ALTER TABLE projects ADD COLUMN tag_catalog_epoch uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE project_tags (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    name text NOT NULL,
    name_key text COLLATE "C" NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX project_tags_project_name_key_idx ON project_tags (project_id, name_key);

CREATE TABLE task_tags (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    PRIMARY KEY (project_id, task_id, tag_id)
);

CREATE INDEX task_tags_project_tag_task_idx ON task_tags (project_id, tag_id, task_id);
