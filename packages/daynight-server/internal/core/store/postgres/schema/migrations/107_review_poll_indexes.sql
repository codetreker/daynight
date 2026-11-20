CREATE INDEX project_pr_review_assignments_worker_cursor
    ON project_pr_review_assignments (user_id, worker_id, project_id, repository_id, github_pr_id);

CREATE INDEX project_pull_requests_open_github_id
    ON project_pull_requests (project_id, repository_id, github_id) INCLUDE (number) WHERE state = 'open';
