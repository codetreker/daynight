CREATE TABLE project_pr_review_assignments (
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    repository_id bigint NOT NULL,
    github_pr_id bigint NOT NULL,
    worker_id uuid NOT NULL,
    assigned_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, project_id, repository_id, github_pr_id)
);

CREATE INDEX workers_review_participants ON workers (user_id, worker_id) WHERE review_enabled;
