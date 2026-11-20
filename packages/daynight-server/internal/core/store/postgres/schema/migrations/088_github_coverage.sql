CREATE TABLE project_github_coverage (
    project_id uuid NOT NULL,
    repository_id bigint NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    PRIMARY KEY (project_id, repository_id, started_at),
    CHECK (started_at = date_trunc('second', started_at)),
    CHECK (ended_at IS NULL OR (ended_at = date_trunc('second', ended_at) AND ended_at > started_at))
);
CREATE UNIQUE INDEX project_github_coverage_open ON project_github_coverage (project_id, repository_id) WHERE ended_at IS NULL;

WITH boundary AS (SELECT date_trunc('second', clock_timestamp()) AS at),
 initialized AS (
    INSERT INTO project_github_coverage (project_id, repository_id, started_at)
    SELECT project_id, repository_id, boundary.at FROM project_github CROSS JOIN boundary
    WHERE sync_enabled AND repository_id IS NOT NULL
    RETURNING project_id
)
UPDATE project_github g SET
    revision = revision + 1,
    last_full_generation = NULL,
    next_poll_at = CASE WHEN enabled AND access_state = 'available' THEN boundary.at ELSE next_poll_at END,
    updated_at = boundary.at
FROM initialized, boundary WHERE g.project_id = initialized.project_id;
