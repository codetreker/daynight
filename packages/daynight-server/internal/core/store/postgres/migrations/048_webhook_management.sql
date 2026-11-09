-- Relations are checked by the owning transaction scopes. Foreign keys would
-- acquire implicit locks outside the webhook lock order.
CREATE TABLE webhook_endpoints (
    id uuid PRIMARY KEY,
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal', 'team')),
    owner_id uuid NOT NULL,
    name text,
    enabled boolean NOT NULL,
    config_version bigint NOT NULL CHECK (config_version > 0),
    destination_revision bigint NOT NULL CHECK (destination_revision > 0),
    destination_kind text,
    adapter_version bigint,
    configuration_schema_version smallint,
    destination_origin text,
    destination_configuration bytea,
    active_key_id uuid,
    created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
    updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
    deleted_at timestamptz CHECK (isfinite(deleted_at)),
    CHECK (
        (deleted_at IS NULL AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 120
            AND destination_kind = 'http' AND adapter_version = 1 AND configuration_schema_version = 1
            AND destination_origin IS NOT NULL AND destination_configuration IS NOT NULL
            AND octet_length(destination_configuration) BETWEEN 1 AND 262144
            AND active_key_id IS NOT NULL
            AND destination_kind IS NOT NULL AND adapter_version IS NOT NULL
            AND configuration_schema_version IS NOT NULL)
        OR
        (deleted_at IS NOT NULL AND NOT enabled AND name IS NULL AND destination_kind IS NULL
            AND adapter_version IS NULL AND configuration_schema_version IS NULL AND destination_origin IS NULL
            AND destination_configuration IS NULL AND active_key_id IS NULL)
    )
);
CREATE INDEX webhook_endpoints_owner ON webhook_endpoints (owner_kind, owner_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX webhook_endpoints_deleted ON webhook_endpoints (deleted_at, id) WHERE deleted_at IS NOT NULL;

CREATE TABLE webhook_signing_keys (
    id uuid PRIMARY KEY,
    endpoint_id uuid NOT NULL,
    slot text NOT NULL CHECK (slot IN ('current', 'overlap')),
    secret bytea NOT NULL CHECK (octet_length(secret) = 32),
    created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
    overlap_started_at timestamptz CHECK (isfinite(overlap_started_at)),
    overlap_until timestamptz CHECK (isfinite(overlap_until)),
    UNIQUE (endpoint_id, slot),
    CHECK ((slot = 'current' AND overlap_started_at IS NULL AND overlap_until IS NULL)
        OR (slot = 'overlap' AND overlap_started_at IS NOT NULL AND overlap_until IS NOT NULL
            AND overlap_until > overlap_started_at AND overlap_until <= overlap_started_at + interval '7 days'))
);

CREATE TABLE webhook_operations (
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal', 'team')),
    owner_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    endpoint_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('endpoint.create', 'endpoint.patch', 'endpoint.delete', 'signing-secret.rotate')),
    issued_at_lexeme text NOT NULL,
    request_sha256 bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
    fingerprint_version smallint NOT NULL CHECK (fingerprint_version = 1),
    semantic_fingerprint bytea NOT NULL CHECK (octet_length(semantic_fingerprint) = 32),
    effect text NOT NULL CHECK (effect IN ('applied', 'unchanged')),
    config_version_after bigint NOT NULL CHECK (config_version_after > 0),
    destination_revision_after bigint NOT NULL CHECK (destination_revision_after > 0),
    key_id_after uuid,
    signing_mode_after text,
    overlap_until_after timestamptz CHECK (isfinite(overlap_until_after)),
    recorded_at timestamptz NOT NULL CHECK (isfinite(recorded_at)),
    expires_at timestamptz NOT NULL CHECK (isfinite(expires_at) AND expires_at > recorded_at),
    PRIMARY KEY (owner_kind, owner_id, operation_id),
    CHECK ((kind = 'signing-secret.rotate' AND key_id_after IS NOT NULL
            AND ((signing_mode_after = 'overlap' AND overlap_until_after IS NOT NULL)
                OR (signing_mode_after = 'immediate' AND overlap_until_after IS NULL))
            AND signing_mode_after IS NOT NULL)
        OR (kind <> 'signing-secret.rotate' AND key_id_after IS NULL
            AND signing_mode_after IS NULL AND overlap_until_after IS NULL))
);
CREATE INDEX webhook_operations_expiry ON webhook_operations (expires_at, owner_kind, owner_id, operation_id);
CREATE INDEX webhook_operations_endpoint ON webhook_operations (endpoint_id, expires_at, operation_id);

CREATE TABLE webhook_policies (
    version bigint PRIMARY KEY CHECK (version > 0),
    max_automatic_attempts smallint NOT NULL CHECK (max_automatic_attempts > 0),
    automatic_window_seconds integer NOT NULL CHECK (automatic_window_seconds > 0),
    automatic_offsets_seconds integer[] NOT NULL CHECK (array_ndims(automatic_offsets_seconds) = 1 AND array_lower(automatic_offsets_seconds, 1) = 1 AND array_position(automatic_offsets_seconds, NULL) IS NULL AND cardinality(automatic_offsets_seconds) = max_automatic_attempts),
    max_manual_operations smallint NOT NULL CHECK (max_manual_operations > 0),
    payload_retention_seconds integer NOT NULL CHECK (payload_retention_seconds > 0),
    metadata_retention_seconds integer NOT NULL CHECK (metadata_retention_seconds > 0),
    operation_retention_seconds integer NOT NULL CHECK (operation_retention_seconds > 0),
    operation_max_age_seconds integer NOT NULL CHECK (operation_max_age_seconds > 0),
    operation_future_skew_seconds integer NOT NULL CHECK (operation_future_skew_seconds >= 0),
    http_timeout_seconds integer NOT NULL CHECK (http_timeout_seconds > 0),
    lease_seconds integer NOT NULL CHECK (lease_seconds > 0),
    minimum_failure_wait_seconds integer NOT NULL CHECK (minimum_failure_wait_seconds > 0),
    jitter_basis_points integer NOT NULL CHECK (jitter_basis_points BETWEEN 0 AND 10000),
    jitter_max_seconds integer NOT NULL CHECK (jitter_max_seconds >= 0),
    key_overlap_default_seconds integer NOT NULL CHECK (key_overlap_default_seconds > 0),
    key_overlap_max_seconds integer NOT NULL CHECK (key_overlap_max_seconds >= key_overlap_default_seconds)
);
INSERT INTO webhook_policies VALUES
    (1, 10, 259200, ARRAY[0,60,300,1800,7200,21600,43200,86400,172800,255600],
     3, 604800, 2592000, 2592000, 300, 60, 15, 45, 5, 1000, 1800, 86400, 604800);

CREATE FUNCTION webhook_policy_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'webhook policies are immutable';
END
$$;
CREATE TRIGGER webhook_policy_no_update BEFORE UPDATE ON webhook_policies
    FOR EACH ROW EXECUTE FUNCTION webhook_policy_no_update();
