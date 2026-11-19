CREATE TABLE assistant_task_inboxes (
    inbox_id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    state text NOT NULL,
    token_digest text,
    overlap_token_digest text,
    overlap_until timestamptz,
    suppressed_count bigint NOT NULL,
    version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    rotated_at timestamptz
);

-- A task has at most one live inbox. Tombstones keep their inbox_id forever so
-- a disabled or deleted inbox can never be revived.
CREATE UNIQUE INDEX assistant_task_inboxes_live ON assistant_task_inboxes (task_id)
    WHERE state = 'enabled';

CREATE TABLE assistant_task_inbox_receipts (
    inbox_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    body_sha256 text NOT NULL,
    event_id uuid,
    suppressed boolean NOT NULL,
    target_bot_id uuid NOT NULL,
    subject_task_id uuid,
    received_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (inbox_id, idempotency_key)
);
CREATE INDEX assistant_task_inbox_receipts_wake
    ON assistant_task_inbox_receipts (target_bot_id, subject_task_id, received_at);
CREATE INDEX assistant_task_inbox_receipts_expiry
    ON assistant_task_inbox_receipts (task_id, expires_at);

CREATE INDEX assistant_task_events_inbound_settled
    ON assistant_task_events (task_id, (COALESCE(delivered_at, created_at)))
    WHERE type = 'inbound' AND state IN ('delivered', 'expired');
