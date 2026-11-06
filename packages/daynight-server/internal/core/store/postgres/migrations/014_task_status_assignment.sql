ALTER TABLE tasks ALTER COLUMN status SET DEFAULT 'todo';

UPDATE tasks
SET status = 'todo',
    version = version + 1,
    updated_at = statement_timestamp()
WHERE status = 'proposed';

ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('todo', 'in_progress', 'done'));
