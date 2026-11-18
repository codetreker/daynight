ALTER TABLE project_github
    ADD COLUMN hook_repository_id bigint,
    ADD COLUMN hook_version bigint,
    ADD COLUMN hook_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN hook_secret bytea,
    ADD COLUMN hook_last_received_at timestamptz;
