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

-- settled_at records when an event left pending. Expiring an event leaves
-- delivered_at NULL, and a paused task can keep an event pending for a long
-- time, so neither column measures how long a settled event has been retained.
-- Existing expired events have no recorded expiry time; they are settled at
-- migration time so retention never ends before the real settlement age.
ALTER TABLE assistant_task_events ADD COLUMN settled_at timestamptz;
UPDATE assistant_task_events SET settled_at = COALESCE(delivered_at, clock_timestamp())
    WHERE state <> 'pending';

CREATE INDEX assistant_task_events_inbound_settled
    ON assistant_task_events (task_id, settled_at)
    WHERE type = 'inbound' AND state IN ('delivered', 'expired');
