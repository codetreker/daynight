ALTER TABLE task_sessions ADD COLUMN online_mode text;
-- Existing executions retain their established online behavior, including unconnected registrations.
UPDATE task_sessions SET online_mode = 'legacy';
