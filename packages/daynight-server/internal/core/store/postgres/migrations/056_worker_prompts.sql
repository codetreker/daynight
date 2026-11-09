CREATE TABLE worker_prompts (
    user_id uuid NOT NULL,
    scope text NOT NULL,
    scope_id uuid NOT NULL,
    revision bigint NOT NULL,
    prompt_text text NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, scope, scope_id)
);
