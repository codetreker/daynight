-- Existing pull requests can only be attributed to the preserved, verified
-- connection identity. Abort before changing the table if that identity is absent.
DO $$
DECLARE
    invalid_project uuid;
BEGIN
    SELECT p.project_id INTO invalid_project
    FROM project_pull_requests p
    LEFT JOIN project_github g ON g.project_id = p.project_id
    WHERE g.repository_id IS NULL OR g.repository_id <= 0
       OR g.repository_full_name IS NULL
       OR g.repository_full_name !~ '^[^/]+/[^/]+$'
       OR split_part(g.repository_full_name, '/', 1) IN ('.', '..')
       OR split_part(g.repository_full_name, '/', 2) IN ('.', '..')
    ORDER BY p.project_id LIMIT 1;
    IF invalid_project IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'DN093',
            MESSAGE = 'missing trustworthy GitHub repository identity', DETAIL = invalid_project::text;
    END IF;
END $$;

CREATE TABLE project_github_repositories (
    project_id uuid NOT NULL,
    repository_id bigint NOT NULL,
    full_name text NOT NULL,
    PRIMARY KEY (project_id, repository_id)
);

ALTER TABLE project_github ADD COLUMN legacy_repository_id bigint;
INSERT INTO project_github_repositories (project_id, repository_id, full_name)
SELECT project_id, repository_id, repository_full_name FROM project_github
WHERE repository_id > 0 AND repository_full_name ~ '^[^/]+/[^/]+$'
  AND split_part(repository_full_name, '/', 1) NOT IN ('.', '..')
  AND split_part(repository_full_name, '/', 2) NOT IN ('.', '..');

UPDATE project_github g SET legacy_repository_id = r.repository_id
FROM project_github_repositories r
WHERE r.project_id = g.project_id;

ALTER TABLE project_pull_requests ADD COLUMN repository_id bigint;
UPDATE project_pull_requests p SET repository_id = g.legacy_repository_id
FROM project_github g WHERE g.project_id = p.project_id;
ALTER TABLE project_pull_requests ALTER COLUMN repository_id SET NOT NULL;
ALTER TABLE project_pull_requests DROP CONSTRAINT project_pull_requests_pkey;
ALTER TABLE project_pull_requests ADD PRIMARY KEY (project_id, repository_id, number);
DROP INDEX project_pull_requests_state_number;
DROP INDEX project_pull_requests_author_number;
CREATE INDEX project_pull_requests_state_number ON project_pull_requests (project_id, repository_id, state, number DESC);
CREATE INDEX project_pull_requests_author_number ON project_pull_requests (project_id, repository_id, author_id, number DESC) WHERE author_id IS NOT NULL;
