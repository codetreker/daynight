ALTER TABLE tasks
    ADD COLUMN started_at timestamptz,
    ADD COLUMN completed_at timestamptz;
