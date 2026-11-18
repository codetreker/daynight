ALTER TABLE projects
    ADD COLUMN execution_warning_minutes integer NOT NULL DEFAULT 60 CHECK (execution_warning_minutes > 0),
    ADD COLUMN settings_version bigint NOT NULL DEFAULT 1 CHECK (settings_version > 0);
