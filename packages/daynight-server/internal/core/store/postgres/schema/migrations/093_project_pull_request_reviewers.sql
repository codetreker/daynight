ALTER TABLE workers ADD COLUMN review_enabled boolean NOT NULL DEFAULT false;

CREATE INDEX workers_review_enabled_last_seen
    ON workers (last_seen_at) WHERE review_enabled;

CREATE TABLE project_pull_request_reviewers (
    project_id uuid NOT NULL,
    github_id bigint NOT NULL,
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    assigned_at timestamptz NOT NULL,
    PRIMARY KEY (project_id, github_id)
);
