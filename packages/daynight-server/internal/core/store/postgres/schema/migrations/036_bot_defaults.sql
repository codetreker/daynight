CREATE TABLE bot_worker_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id),
    worker_id uuid NOT NULL,
    creation_order bigint NOT NULL CHECK (creation_order > 0),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)
);

CREATE TABLE bot_configuration_preferences (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    cwd text,
    cwd_creation_order bigint,
    provider text CHECK (provider IN ('codex', 'claude', 'copilot')),
    provider_creation_order bigint,
    PRIMARY KEY (user_id, worker_id),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id),
    CHECK ((cwd IS NULL AND cwd_creation_order IS NULL)
        OR (cwd IS NOT NULL AND cwd_creation_order IS NOT NULL AND cwd_creation_order > 0)),
    CHECK ((provider IS NULL AND provider_creation_order IS NULL)
        OR (provider IS NOT NULL AND provider_creation_order IS NOT NULL AND provider_creation_order > 0)),
    CHECK (cwd IS NOT NULL OR provider IS NOT NULL)
);
