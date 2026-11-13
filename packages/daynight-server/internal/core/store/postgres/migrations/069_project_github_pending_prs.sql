CREATE TABLE project_github_pending_prs (
    project_id uuid NOT NULL,
    number bigint NOT NULL,
    generation bigint NOT NULL,
    request_id uuid NOT NULL,
    delivery_id text NOT NULL,
    received_at timestamptz NOT NULL,
    next_attempt_at timestamptz NOT NULL,
    PRIMARY KEY (project_id, number)
);

CREATE INDEX project_github_pending_prs_due ON project_github_pending_prs (next_attempt_at, project_id);
