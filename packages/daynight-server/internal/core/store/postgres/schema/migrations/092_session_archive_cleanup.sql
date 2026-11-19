ALTER TABLE session_archive_retention ADD COLUMN cleaned_at timestamptz;
ALTER TABLE session_archive_retention ADD CONSTRAINT archive_cleanup_requires_expiration
    CHECK (cleaned_at IS NULL OR expired_at IS NOT NULL);
CREATE INDEX session_archive_retention_cleanup
    ON session_archive_retention(session_id) WHERE cleaned_at IS NULL;

-- Retention metadata can predate cleanup enablement. Preserve a full reading
-- period for existing legacy archives without reviving expiration tombstones.
UPDATE session_archive_retention retention
SET grace_until = statement_timestamp() + interval '168 hours',
    expires_at = NULL, reason = 'pending', version = retention.version + 1
FROM session_archives archive
JOIN task_sessions session ON session.id = archive.session_id
JOIN tasks task ON task.id = session.task_id AND task.project_id = session.project_id
LEFT JOIN session_archive_bundles bundle ON bundle.session_id = archive.session_id
WHERE retention.session_id = archive.session_id AND retention.expired_at IS NULL
    AND archive.state = 'ready' AND session.backend = 'web'
    AND session.scope = 'task' AND session.bot_id IS NULL AND task.type = 'task'
    AND (archive.schema_version <> 3 OR COALESCE(bundle.ledger->>'ContentPolicy', '') <> 'task_body')
    AND (retention.grace_until IS NULL OR retention.grace_until < statement_timestamp() + interval '168 hours');
