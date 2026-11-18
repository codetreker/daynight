CREATE INDEX project_pull_requests_author_number ON project_pull_requests (project_id, author_id, number DESC) WHERE author_id IS NOT NULL;
