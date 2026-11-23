CREATE TABLE worker_lifecycle (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    protocol_version smallint NOT NULL,
    intent_version bigint NOT NULL,
    desired text NOT NULL,
    admission text NOT NULL,
    current_operation_id uuid,
    instance_id uuid,
    instance_epoch bigint NOT NULL,
    capability_version smallint,
    bootstrap_consumed boolean NOT NULL DEFAULT false,
    reconnect_allowed boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, worker_id),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id) ON DELETE CASCADE,
    CHECK (protocol_version = 1),
    CHECK (intent_version > 0),
    CHECK (instance_epoch >= 0),
    CHECK (desired IN ('enabled', 'disabled')),
    CHECK (admission IN ('open', 'closed')),
    CHECK (desired <> 'disabled' OR admission = 'closed')
);

CREATE TABLE worker_lifecycle_operations (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    action text NOT NULL,
    source text NOT NULL,
    request_kind text NOT NULL,
    request_hash bytea NOT NULL,
    request jsonb NOT NULL,
    intent_version bigint NOT NULL,
    state text NOT NULL,
    receipt jsonb NOT NULL,
    activation jsonb,
    activation_request jsonb,
    activation_hash bytea,
    activation_outcome text NOT NULL DEFAULT 'not_started',
    error_code text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, worker_id, operation_id),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id) ON DELETE CASCADE,
    CHECK (octet_length(request_hash) = 32),
    CHECK (activation_hash IS NULL OR octet_length(activation_hash) = 32),
    CHECK (activation_outcome IN ('not_started', 'committed', 'not_committed'))
);

CREATE TABLE worker_lifecycle_observations (
    user_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    instance_epoch bigint NOT NULL,
    intent_version bigint NOT NULL,
    local_epoch bigint NOT NULL,
    scope_generation bigint NOT NULL,
    report_sequence bigint NOT NULL,
    observation jsonb NOT NULL,
    received_at timestamptz NOT NULL,
    PRIMARY KEY (user_id, worker_id),
    FOREIGN KEY (user_id, worker_id) REFERENCES workers(user_id, worker_id) ON DELETE CASCADE
);

ALTER TABLE session_operations ADD COLUMN worker_id uuid;
ALTER TABLE session_operations ADD COLUMN worker_intent_version bigint;
ALTER TABLE session_operations ADD CONSTRAINT session_operations_worker_intent_version_check
    CHECK (worker_intent_version > 0);
ALTER TABLE session_operations ADD CONSTRAINT session_operations_worker_intent_owner_check
    CHECK (worker_intent_version IS NULL OR worker_id IS NOT NULL);
