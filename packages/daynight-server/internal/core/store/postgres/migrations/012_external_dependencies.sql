ALTER TABLE task_dependencies
    ADD COLUMN external boolean NOT NULL DEFAULT false;
