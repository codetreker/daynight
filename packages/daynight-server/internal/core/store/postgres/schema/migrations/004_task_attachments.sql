CREATE TABLE task_attachments (
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    path text COLLATE "C" NOT NULL CHECK (path <> ''),
    content_type text NOT NULL CHECK (content_type <> ''),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (task_id, path)
);
