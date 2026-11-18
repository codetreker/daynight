ALTER TABLE project_github ADD COLUMN sync_enabled boolean NOT NULL DEFAULT false;

UPDATE project_github SET
    version = version + 1,
    generation = generation + 1,
    revision = revision + 1,
    next_poll_at = NULL,
    next_access_check_at = NULL,
    claim_token = NULL,
    claim_until = NULL,
    claim_kind = NULL,
    access_hint_id = NULL,
    access_delivery_id = NULL;

DELETE FROM project_github_pending_prs;

ALTER TABLE project_github ADD CONSTRAINT project_github_sync_requires_connection CHECK (NOT sync_enabled OR enabled);
DROP INDEX project_github_poll_due;
DROP INDEX project_github_access_due;
CREATE INDEX project_github_poll_due ON project_github (next_poll_at, project_id) WHERE enabled AND sync_enabled;
CREATE INDEX project_github_access_due ON project_github (next_access_check_at, project_id) WHERE enabled AND sync_enabled;
