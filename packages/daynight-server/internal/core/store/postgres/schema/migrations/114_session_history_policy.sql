ALTER TABLE task_sessions ADD COLUMN history_content_policy text CHECK (history_content_policy IN ('legacy', 'task_body'));
