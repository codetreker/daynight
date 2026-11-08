-- Each attempt records a committed admission, independently of HTTP observations.
CREATE TABLE webhook_attempts (
    id uuid PRIMARY KEY,
    delivery_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    generation bigint NOT NULL CHECK (generation > 0),
    sequence smallint NOT NULL CHECK (sequence BETWEEN 1 AND 13),
    trigger text NOT NULL CHECK (trigger IN ('automatic', 'manual')),
    lease_token uuid NOT NULL,
    destination_revision bigint NOT NULL CHECK (destination_revision > 0),
    signing_key_ids uuid[] NOT NULL CHECK (array_ndims(signing_key_ids) = 1 AND array_lower(signing_key_ids, 1) = 1
        AND cardinality(signing_key_ids) BETWEEN 1 AND 2 AND array_position(signing_key_ids, NULL) IS NULL
        AND (cardinality(signing_key_ids) = 1 OR signing_key_ids[1] <> signing_key_ids[2])),
    automatic_plan_slot smallint,
    manual_operation_id uuid,
    claimed_at timestamptz NOT NULL CHECK (isfinite(claimed_at)),
    admitted_at timestamptz NOT NULL CHECK (isfinite(admitted_at)),
    retention_closed_at timestamptz CHECK (isfinite(retention_closed_at)),
    dispatched_at timestamptz CHECK (isfinite(dispatched_at)),
    finished_at timestamptz CHECK (isfinite(finished_at)),
    outcome text CHECK (outcome IN ('acknowledged', 'http_error', 'receiver_error', 'transport_error', 'unknown', 'cancelled', 'policy_denied', 'render_error')),
    http_status smallint CHECK (http_status BETWEEN 100 AND 599),
    duration_ms bigint CHECK (duration_ms >= 0),
    error_code text,
    retry_after_not_before timestamptz CHECK (isfinite(retry_after_not_before)),
    retry_after_diagnostic_code text CHECK (retry_after_diagnostic_code = 'invalid_retry_after'),
    recovered_unknown_at timestamptz CHECK (isfinite(recovered_unknown_at)),
    late_observed_at timestamptz CHECK (isfinite(late_observed_at)),
    late_outcome text CHECK (late_outcome IN ('acknowledged', 'http_error', 'receiver_error', 'transport_error', 'unknown', 'cancelled', 'policy_denied', 'render_error')),
    late_http_status smallint CHECK (late_http_status BETWEEN 100 AND 599),
    late_duration_ms bigint CHECK (late_duration_ms >= 0),
    late_error_code text,
    late_retry_after_not_before timestamptz CHECK (isfinite(late_retry_after_not_before)),
    late_retry_after_diagnostic_code text CHECK (late_retry_after_diagnostic_code = 'invalid_retry_after'),
    UNIQUE (delivery_id, sequence),
    UNIQUE (delivery_id, lease_token),
    CHECK ((trigger = 'automatic' AND automatic_plan_slot BETWEEN 1 AND 10 AND automatic_plan_slot IS NOT NULL AND manual_operation_id IS NULL)
        OR (trigger = 'manual' AND automatic_plan_slot IS NULL AND manual_operation_id IS NOT NULL)),
    CHECK ((finished_at IS NULL AND outcome IS NULL AND http_status IS NULL AND duration_ms IS NULL AND error_code IS NULL
            AND retry_after_not_before IS NULL AND retry_after_diagnostic_code IS NULL)
        OR (finished_at IS NOT NULL AND outcome IS NOT NULL)),
    CHECK (retry_after_not_before IS NULL OR retry_after_diagnostic_code IS NULL),
    CHECK ((late_observed_at IS NULL AND late_outcome IS NULL AND late_http_status IS NULL AND late_duration_ms IS NULL
            AND late_error_code IS NULL AND late_retry_after_not_before IS NULL AND late_retry_after_diagnostic_code IS NULL)
        OR (late_observed_at IS NOT NULL AND late_outcome IS NOT NULL AND recovered_unknown_at IS NOT NULL)),
    CHECK (late_retry_after_not_before IS NULL OR late_retry_after_diagnostic_code IS NULL)
);
CREATE INDEX webhook_attempts_history ON webhook_attempts (delivery_id, generation, sequence, id);

CREATE TABLE webhook_endpoint_waits (
    endpoint_id uuid NOT NULL,
    destination_revision bigint NOT NULL CHECK (destination_revision > 0),
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal', 'team')),
    owner_id uuid NOT NULL,
    not_before timestamptz CHECK (isfinite(not_before)),
    updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
    PRIMARY KEY (endpoint_id, destination_revision)
);
CREATE INDEX webhook_endpoint_waits_owner ON webhook_endpoint_waits (owner_kind, owner_id, endpoint_id, destination_revision);

-- Preserve each current revision when upgrading an existing deployment.
INSERT INTO webhook_endpoint_waits (endpoint_id, destination_revision, owner_kind, owner_id, updated_at)
SELECT id, destination_revision, owner_kind, owner_id, updated_at
FROM webhook_endpoints WHERE deleted_at IS NULL;
