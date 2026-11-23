CREATE TABLE assistant_tasks (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    application text NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    scope text NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    takeover text NOT NULL,
    trigger jsonb,
    version bigint NOT NULL,
    manual_version bigint NOT NULL,
    claim_generation bigint NOT NULL,
    holder_bot_id uuid,
    claim_token_hash text,
    credential_operation_id uuid,
    claimed_at timestamptz,
    renewed_at timestamptz,
    lease_until timestamptz,
    record_last_created_at timestamptz,
    record_last_id uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX assistant_tasks_owner_application ON assistant_tasks (owner_user_id, application)
    WHERE application <> '' AND state <> 'deleted';
CREATE INDEX assistant_tasks_owner_page ON assistant_tasks (owner_user_id, created_at, id);
CREATE INDEX assistant_tasks_holder ON assistant_tasks (holder_bot_id, state);

CREATE TABLE assistant_task_manual_versions (
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    version bigint NOT NULL,
    body text NOT NULL,
    rules jsonb NOT NULL,
    source text NOT NULL,
    proposal_id uuid,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (task_id, version)
);

CREATE TABLE assistant_task_appendix (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    text text NOT NULL,
    source_records jsonb NOT NULL,
    author_bot_id uuid,
    state text NOT NULL,
    version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX assistant_task_appendix_page ON assistant_task_appendix (task_id, created_at, id);

CREATE TABLE assistant_task_proposals (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    base_version bigint NOT NULL,
    body text NOT NULL,
    rules jsonb NOT NULL,
    reason text NOT NULL,
    evidence_records jsonb NOT NULL,
    author_bot_id uuid,
    widens boolean NOT NULL,
    status text NOT NULL,
    decision_note text NOT NULL,
    decided_at timestamptz,
    created_at timestamptz NOT NULL
);
CREATE INDEX assistant_task_proposals_page ON assistant_task_proposals (task_id, created_at, id);

CREATE TABLE assistant_task_items (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    key text NOT NULL,
    episode bigint NOT NULL,
    state text NOT NULL,
    category text NOT NULL,
    follower_bot_id uuid,
    app_state jsonb NOT NULL,
    version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX assistant_task_items_open_key ON assistant_task_items (task_id, key) WHERE state = 'open';
CREATE INDEX assistant_task_items_page ON assistant_task_items (task_id, created_at, id);

CREATE TABLE assistant_task_records (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    item_id uuid,
    author text NOT NULL,
    author_bot_id uuid,
    kind text NOT NULL,
    text text NOT NULL,
    refs jsonb NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE INDEX assistant_task_records_page ON assistant_task_records (task_id, created_at, id);
CREATE INDEX assistant_task_records_item_page ON assistant_task_records (task_id, item_id, created_at, id);

CREATE TABLE assistant_task_events (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    target_bot_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    state text NOT NULL,
    attention boolean NOT NULL,
    delivered_at timestamptz,
    seen_at timestamptz,
    ack_operation_id uuid,
    ack_fingerprint text,
    created_at timestamptz NOT NULL
);
CREATE INDEX assistant_task_events_target_state ON assistant_task_events (target_bot_id, state);
CREATE INDEX assistant_task_events_page ON assistant_task_events (task_id, created_at, id);

CREATE TABLE assistant_task_inquiries (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    item_id uuid,
    from_bot_id uuid NOT NULL,
    to_bot_id uuid NOT NULL,
    answer_bot_id uuid,
    question text NOT NULL,
    answer text NOT NULL,
    state text NOT NULL,
    deadline timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    answered_at timestamptz
);
CREATE INDEX assistant_task_inquiries_state_deadline ON assistant_task_inquiries (state, deadline);
CREATE INDEX assistant_task_inquiries_page ON assistant_task_inquiries (task_id, created_at, id);

CREATE TABLE assistant_task_claim_operations (
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    actor_bot_id uuid,
    request_fingerprint text NOT NULL,
    admitted_at timestamptz NOT NULL,
    resulting_version bigint NOT NULL,
    resulting_generation bigint NOT NULL,
    holder_bot_id uuid,
    credential_operation_id uuid,
    lease_until timestamptz,
    PRIMARY KEY (owner_user_id, task_id, operation_id)
);
