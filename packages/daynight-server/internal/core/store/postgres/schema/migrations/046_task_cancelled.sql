ALTER TABLE tasks ADD COLUMN cancelled_at timestamptz;

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled'));
ALTER TABLE tasks ADD CONSTRAINT tasks_cancelled_at_check
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));
