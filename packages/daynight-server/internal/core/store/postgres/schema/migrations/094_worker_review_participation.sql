ALTER TABLE workers
    ADD COLUMN review_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN review_version bigint NOT NULL DEFAULT 1;
