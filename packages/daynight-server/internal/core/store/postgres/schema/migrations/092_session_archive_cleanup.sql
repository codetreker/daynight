ALTER TABLE session_archive_retention ADD COLUMN cleaned_at timestamptz;
ALTER TABLE session_archive_retention ADD CONSTRAINT archive_cleanup_requires_expiration
    CHECK (cleaned_at IS NULL OR expired_at IS NOT NULL);
CREATE INDEX session_archive_retention_cleanup
    ON session_archive_retention(session_id) WHERE cleaned_at IS NULL;
