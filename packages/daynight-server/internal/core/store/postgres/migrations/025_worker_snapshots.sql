CREATE TABLE workers (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    telemetry jsonb NOT NULL CHECK (jsonb_typeof(telemetry) = 'object'),
    task_snapshot jsonb NOT NULL CHECK (jsonb_typeof(task_snapshot) = 'object'),
    PRIMARY KEY (user_id, worker_id)
);
CREATE INDEX workers_recent ON workers (user_id, last_seen_at DESC, worker_id);
