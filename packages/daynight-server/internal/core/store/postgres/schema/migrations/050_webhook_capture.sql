-- Capture shares the source transaction. Relationships are checked by the
-- owning transaction and have no foreign keys or implicit lock acquisition.
CREATE SEQUENCE webhook_delivery_queue_order_seq AS bigint;

CREATE TABLE webhook_events (
    id uuid PRIMARY KEY,
    event_type text NOT NULL CHECK (event_type IN ('task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted')),
    wire_version smallint NOT NULL CHECK (wire_version = 1),
    schema_version smallint NOT NULL CHECK (schema_version = 1),
    source text NOT NULL,
    subject text NOT NULL,
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_version bigint,
    task_deleted_at timestamptz CHECK (isfinite(task_deleted_at)),
    step_id bigint,
    message_id uuid,
    occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
    recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
    origin_request_id text CHECK (octet_length(origin_request_id) BETWEEN 1 AND 128),
    fact_codec_version smallint NOT NULL CHECK (fact_codec_version = 1),
    fact_bytes bytea,
    fact_sha256 bytea NOT NULL CHECK (octet_length(fact_sha256) = 32),
    original_fact_bytes integer NOT NULL CHECK (original_fact_bytes BETWEEN 1 AND 65536),
    fact_removed_at timestamptz CHECK (isfinite(fact_removed_at)),
    CHECK (source = 'urn:daynight:project:' || project_id::text),
    CHECK (
        (event_type = 'task.thread_posted' AND task_version IS NULL AND task_deleted_at IS NULL
            AND step_id IS NULL AND message_id IS NOT NULL AND subject = 'tasks/' || task_id::text || '/thread/' || message_id::text)
        OR (event_type = 'task.step_updated' AND task_version > 0 AND task_version IS NOT NULL
            AND task_deleted_at IS NULL AND step_id BETWEEN 0 AND 4294967295 AND step_id IS NOT NULL
            AND message_id IS NULL AND subject = 'tasks/' || task_id::text || '/steps')
        OR (event_type = 'task.deleted' AND task_version > 0 AND task_version IS NOT NULL
            AND task_deleted_at IS NOT NULL AND step_id IS NULL AND message_id IS NULL
            AND subject = 'tasks/' || task_id::text)
        OR (event_type IN ('task.created', 'task.status_changed', 'task.paused') AND task_version > 0
            AND task_version IS NOT NULL AND task_deleted_at IS NULL AND step_id IS NULL AND message_id IS NULL
            AND subject = 'tasks/' || task_id::text)
    ),
    CHECK ((fact_bytes IS NOT NULL AND fact_removed_at IS NULL AND octet_length(fact_bytes) = original_fact_bytes AND sha256(fact_bytes) = fact_sha256)
        OR (fact_bytes IS NULL AND fact_removed_at IS NOT NULL))
);
CREATE INDEX webhook_events_occurred ON webhook_events (occurred_at, id);

CREATE TABLE webhook_deliveries (
    id uuid PRIMARY KEY,
    event_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal', 'team')),
    owner_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted')),
    project_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
    original_match_count bigint NOT NULL CHECK (original_match_count > 0),
    original_match_sha256 bytea NOT NULL CHECK (octet_length(original_match_sha256) = 32),
    policy_version bigint NOT NULL CHECK (policy_version > 0),
    destination_revision bigint NOT NULL CHECK (destination_revision > 0),
    destination_kind text NOT NULL CHECK (destination_kind = 'http'),
    adapter_version bigint NOT NULL CHECK (adapter_version = 1),
    render_version smallint NOT NULL CHECK (render_version = 1),
    configuration_schema_version smallint NOT NULL CHECK (configuration_schema_version = 1),
    destination_origin text NOT NULL CHECK (octet_length(destination_origin) > 0),
    destination_configuration bytea NOT NULL CHECK (octet_length(destination_configuration) BETWEEN 1 AND 262144),
    request_method text NOT NULL CHECK (request_method = 'POST'),
    request_media_type text NOT NULL CHECK (request_media_type = 'application/cloudevents+json'),
    deterministic_headers_json bytea NOT NULL CHECK (deterministic_headers_json = convert_to('[]', 'UTF8')),
    body bytea,
    original_body_bytes integer NOT NULL CHECK (original_body_bytes BETWEEN 1 AND 65536),
    body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
    payload_removed_at timestamptz CHECK (isfinite(payload_removed_at)),
    payload_removed_reason text,
    automatic_schedule_at timestamptz[] NOT NULL,
    automatic_expires_at timestamptz NOT NULL CHECK (isfinite(automatic_expires_at)),
    payload_expires_at timestamptz NOT NULL CHECK (isfinite(payload_expires_at)),
    automatic_plan_cursor smallint NOT NULL CHECK (automatic_plan_cursor BETWEEN 0 AND 10),
    automatic_open boolean NOT NULL,
    automatic_attempt_count smallint NOT NULL CHECK (automatic_attempt_count BETWEEN 0 AND 10),
    manual_operation_count smallint NOT NULL CHECK (manual_operation_count BETWEEN 0 AND 3),
    attempt_sequence smallint NOT NULL CHECK (attempt_sequence BETWEEN 0 AND 13),
    generation bigint NOT NULL CHECK (generation > 0),
    state text NOT NULL CHECK (state IN ('pending', 'leased', 'delivered', 'failed', 'suppressed')),
    trigger text NOT NULL CHECK (trigger IN ('automatic', 'manual')),
    expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
    next_attempt_at timestamptz CHECK (isfinite(next_attempt_at)),
    manual_operation_id uuid,
    lease_token uuid,
    lease_claimed_at timestamptz CHECK (isfinite(lease_claimed_at)),
    lease_until timestamptz CHECK (isfinite(lease_until)),
    lease_generation bigint,
    lease_plan_slot smallint CHECK (lease_plan_slot BETWEEN 1 AND 10),
    current_attempt_id uuid,
    terminal_at timestamptz CHECK (isfinite(terminal_at)),
    last_activity_at timestamptz NOT NULL CHECK (isfinite(last_activity_at)),
    metadata_expires_at timestamptz NOT NULL CHECK (isfinite(metadata_expires_at)),
    preparation_error_code text,
    queue_order bigint NOT NULL DEFAULT nextval('webhook_delivery_queue_order_seq') CHECK (queue_order > 0),
    purging_at timestamptz CHECK (isfinite(purging_at)),
    UNIQUE (event_id, endpoint_id),
    CHECK ((body IS NOT NULL AND payload_removed_at IS NULL AND payload_removed_reason IS NULL
            AND octet_length(body) = original_body_bytes AND sha256(body) = body_sha256)
        OR (body IS NULL AND payload_removed_at IS NOT NULL AND payload_removed_reason = 'expired' AND payload_removed_reason IS NOT NULL)),
    CHECK (array_ndims(automatic_schedule_at) = 1 AND array_lower(automatic_schedule_at, 1) = 1
        AND cardinality(automatic_schedule_at) = 10 AND array_position(automatic_schedule_at, NULL) IS NULL
        AND isfinite(automatic_schedule_at[1]) AND isfinite(automatic_schedule_at[10])
        AND automatic_schedule_at[1] < automatic_schedule_at[2] AND automatic_schedule_at[2] < automatic_schedule_at[3]
        AND automatic_schedule_at[3] < automatic_schedule_at[4] AND automatic_schedule_at[4] < automatic_schedule_at[5]
        AND automatic_schedule_at[5] < automatic_schedule_at[6] AND automatic_schedule_at[6] < automatic_schedule_at[7]
        AND automatic_schedule_at[7] < automatic_schedule_at[8] AND automatic_schedule_at[8] < automatic_schedule_at[9]
        AND automatic_schedule_at[9] < automatic_schedule_at[10]),
    CHECK (policy_version <> 1 OR (automatic_schedule_at[1] = occurred_at
        AND automatic_schedule_at[10] < automatic_expires_at
        AND automatic_expires_at = occurred_at + interval '72 hours'
        AND payload_expires_at = occurred_at + interval '168 hours')),
    CHECK ((lease_token IS NULL AND lease_claimed_at IS NULL AND lease_until IS NULL AND lease_generation IS NULL
            AND lease_plan_slot IS NULL AND current_attempt_id IS NULL AND state <> 'leased')
        OR (lease_token IS NOT NULL AND lease_claimed_at IS NOT NULL AND lease_until IS NOT NULL
            AND lease_until > lease_claimed_at AND lease_generation IS NOT NULL AND lease_generation = generation AND state = 'leased'))
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (next_attempt_at, queue_order, id) WHERE state = 'pending' AND purging_at IS NULL;
CREATE INDEX webhook_deliveries_fifo ON webhook_deliveries (queue_order, id) WHERE state = 'pending' AND purging_at IS NULL;
CREATE INDEX webhook_deliveries_lease ON webhook_deliveries (lease_until, id) WHERE lease_token IS NOT NULL;
CREATE INDEX webhook_deliveries_history ON webhook_deliveries (owner_kind, owner_id, endpoint_id, occurred_at DESC, id DESC);
CREATE INDEX webhook_deliveries_event ON webhook_deliveries (event_id, id);
CREATE INDEX webhook_deliveries_endpoint_revision ON webhook_deliveries (endpoint_id, destination_revision, id);
CREATE INDEX webhook_deliveries_metadata_expiry ON webhook_deliveries (metadata_expires_at, id);
CREATE INDEX webhook_deliveries_purging ON webhook_deliveries (purging_at, id) WHERE purging_at IS NOT NULL;

CREATE TABLE webhook_delivery_matches (
    delivery_id uuid NOT NULL,
    subscription_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    project_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('task.created', 'task.status_changed', 'task.paused', 'task.deleted', 'task.step_updated', 'task.thread_posted')),
    authorization_epoch bigint NOT NULL CHECK (authorization_epoch > 0),
    PRIMARY KEY (delivery_id, subscription_id, binding_id),
    UNIQUE (delivery_id, binding_id)
);
CREATE INDEX webhook_delivery_matches_subscription ON webhook_delivery_matches (subscription_id, delivery_id);
CREATE INDEX webhook_delivery_matches_binding ON webhook_delivery_matches (binding_id, delivery_id);
