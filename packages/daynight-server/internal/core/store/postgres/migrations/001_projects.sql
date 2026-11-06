CREATE TABLE projects (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    repo_url text NOT NULL CHECK (btrim(repo_url) <> ''),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX projects_created_id ON projects (created_at, id);
