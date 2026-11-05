CREATE TABLE task_threads (
    task_id uuid PRIMARY KEY,
    last_created_at timestamptz(3),
    last_message_id uuid,
    CHECK ((last_created_at IS NULL) = (last_message_id IS NULL))
);

CREATE TABLE task_thread_messages (
    task_id uuid NOT NULL,
    message_id uuid NOT NULL DEFAULT gen_random_uuid(),
    created_at timestamptz(3) NOT NULL,
    author_user_id uuid NOT NULL,
    author_display_name text,
    author_agent boolean NOT NULL,
    author_claim_id uuid,
    author_worker_id uuid,
    author_provider text,
    body text NOT NULL,
    reply_to_message_id uuid,
    PRIMARY KEY (task_id, message_id),
    CHECK (
        (NOT author_agent
            AND author_claim_id IS NULL
            AND author_worker_id IS NULL
            AND author_provider IS NULL)
        OR
        (author_agent
            AND author_claim_id IS NOT NULL
            AND author_worker_id IS NOT NULL
            AND author_provider IS NOT NULL
            AND author_provider IN ('codex', 'claude', 'copilot'))
    )
);

CREATE INDEX task_thread_messages_order
ON task_thread_messages (task_id, created_at, message_id);
