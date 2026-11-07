-- Webhook management tables deliberately have no foreign keys into business tables:
-- ownership and lock ordering are enforced by the transaction scopes.
CREATE TABLE webhook_policies (
    version bigint PRIMARY KEY CHECK (version = 1),
    parameters jsonb NOT NULL,
    digest text NOT NULL CHECK (length(digest) = 64)
);
INSERT INTO webhook_policies VALUES (1, '{"attemptBytes":2048,"automaticAttemptSlots":10,"bindingLimit":6,"bucketActiveBytes":134217728,"bucketActiveRecords":32768,"bucketBytes":268435456,"bucketOperations":8192,"bucketQueue":4096,"bucketRecords":65536,"buckets":16,"configurationMetadataBytes":2048,"endpointLimit":20,"endpointQueue":256,"fanoutLimit":256,"maxDeliveryRecords":63,"operationBytes":4096,"ownerActiveBytes":50331648,"ownerActiveRecords":24576,"ownerBytes":67108864,"ownerOperations":1024,"ownerQueue":1024,"ownerRecords":32768,"subscriptionLimit":50,"version":1}'::jsonb, 'b2b44b7d8da24e4214d02ddf85fa8168e1bd0b502fe6d7fef84ebfdcc4d81c4d');

CREATE TABLE webhook_quota_buckets (
    bucket smallint PRIMARY KEY CHECK (bucket >= 0 AND bucket < 16),
    records bigint NOT NULL DEFAULT 0 CHECK (records >= 0 AND records <= 65536),
    bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0 AND bytes <= 268435456),
    active_records bigint NOT NULL DEFAULT 0 CHECK (active_records >= 0 AND active_records <= 32768),
    active_bytes bigint NOT NULL DEFAULT 0 CHECK (active_bytes >= 0 AND active_bytes <= 134217728),
    operations bigint NOT NULL DEFAULT 0 CHECK (operations >= 0 AND operations <= 8192)
);
INSERT INTO webhook_quota_buckets (bucket) SELECT generate_series(0,15);
CREATE TABLE webhook_quota_owners (
    owner_kind text NOT NULL CHECK (owner_kind IN ('user','team')),
    owner_id uuid NOT NULL,
    bucket smallint NOT NULL CHECK (bucket >= 0 AND bucket < 16),
    endpoints bigint NOT NULL DEFAULT 0 CHECK (endpoints >= 0 AND endpoints <= 20),
    records bigint NOT NULL DEFAULT 0 CHECK (records >= 0 AND records <= 32768),
    bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0 AND bytes <= 67108864),
    active_records bigint NOT NULL DEFAULT 0 CHECK (active_records >= 0 AND active_records <= 24576),
    active_bytes bigint NOT NULL DEFAULT 0 CHECK (active_bytes >= 0 AND active_bytes <= 50331648),
    operations bigint NOT NULL DEFAULT 0 CHECK (operations >= 0 AND operations <= 1024),
    PRIMARY KEY (owner_kind,owner_id)
);
CREATE TABLE webhook_endpoints (
    id uuid PRIMARY KEY,
    owner_kind text NOT NULL CHECK (owner_kind IN ('user','team')),
    owner_id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean NOT NULL,
    deleted_at timestamptz,
    config_version bigint NOT NULL CHECK (config_version > 0),
    destination_revision bigint NOT NULL CHECK (destination_revision > 0),
    destination_kind text NOT NULL,
    adapter_version text NOT NULL,
    origin text NOT NULL,
    destination_ciphertext bytea NOT NULL,
    active_key_id text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE INDEX webhook_endpoints_owner ON webhook_endpoints(owner_kind,owner_id,created_at,id) WHERE deleted_at IS NULL;
CREATE TABLE webhook_signing_keys (
    endpoint_id uuid NOT NULL,
    id text NOT NULL,
    ciphertext bytea NOT NULL,
    created_at timestamptz NOT NULL,
    overlap_until timestamptz,
    revoked_at timestamptz,
    PRIMARY KEY(endpoint_id,id)
);
CREATE TABLE webhook_operations (
    owner_kind text NOT NULL CHECK (owner_kind IN ('user','team')),
    owner_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    kind text NOT NULL,
    target_id uuid NOT NULL,
    issued_at text NOT NULL,
    request_sha256 text NOT NULL,
    fingerprint text NOT NULL,
    effect text NOT NULL,
    config_version bigint NOT NULL CHECK (config_version > 0),
    destination_revision_after bigint NOT NULL CHECK (destination_revision_after > 0),
    active_key_id text NOT NULL,
    overlap_until timestamptz,
    recorded_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY(owner_kind,owner_id,operation_id)
);
CREATE INDEX webhook_operations_expiry ON webhook_operations(expires_at,owner_kind,owner_id);
