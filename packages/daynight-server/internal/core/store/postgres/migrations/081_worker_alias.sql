ALTER TABLE workers
    ADD COLUMN alias_value text,
    ADD COLUMN alias_version bigint NOT NULL DEFAULT 1;
