CREATE TABLE session_archive_retention (
    session_id uuid PRIMARY KEY,
    first_succeeded_at timestamptz,
    grace_until timestamptz,
    expires_at timestamptz,
    expired_at timestamptz,
    reason text NOT NULL DEFAULT 'pending',
    version bigint NOT NULL DEFAULT 1,
    members jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- Historical publication times are unknown. Format conversion and duplicate
-- receipts must preserve that fact and this one-time upgrade grace period.
INSERT INTO session_archive_retention(session_id, grace_until)
SELECT archive.session_id, statement_timestamp() + interval '168 hours'
FROM session_archives archive
JOIN task_sessions session ON session.id=archive.session_id
JOIN tasks task ON task.id=session.task_id AND task.project_id=session.project_id
WHERE archive.state='ready' AND session.backend='web'
    AND session.scope='task' AND session.bot_id IS NULL AND task.type='task';
