CREATE TABLE bot_model_preferences (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('codex', 'claude', 'copilot')),
    model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 256),
    creation_order bigint NOT NULL CHECK (creation_order > 0),
    PRIMARY KEY (user_id, worker_id, provider),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)
);

CREATE TABLE bot_effort_preferences (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    provider text NOT NULL CHECK (provider IN ('codex', 'claude', 'copilot')),
    model text NOT NULL CHECK (octet_length(model) BETWEEN 1 AND 256),
    reasoning_effort text NOT NULL CHECK (octet_length(reasoning_effort) BETWEEN 1 AND 64),
    creation_order bigint NOT NULL CHECK (creation_order > 0),
    PRIMARY KEY (user_id, worker_id, provider, model),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id)
);
