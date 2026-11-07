CREATE TABLE webhook_endpoints (
    id uuid PRIMARY KEY,
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal','team')),
    owner_id uuid NOT NULL,
    name text NOT NULL,
    enabled boolean NOT NULL,
    config_version bigint NOT NULL CHECK (config_version > 0),
    destination_revision bigint NOT NULL CHECK (destination_revision > 0),
    destination_kind text NOT NULL,
    adapter_version bigint NOT NULL CHECK (adapter_version > 0),
    destination_origin text NOT NULL,
    encrypted_destination bytea NOT NULL,
    active_key_id uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    CHECK (deleted_at IS NOT NULL OR char_length(name) BETWEEN 1 AND 120)
);
CREATE INDEX webhook_endpoints_owner_list ON webhook_endpoints(owner_kind,owner_id,created_at,id);

CREATE TABLE webhook_subscriptions (
    id uuid PRIMARY KEY,
    endpoint_id uuid NOT NULL,
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal','team')),
    owner_id uuid NOT NULL,
    project_id uuid NOT NULL,
    authorization_state text NOT NULL CHECK (authorization_state IN ('active','confirmation_required')),
    authorization_epoch bigint NOT NULL CHECK (authorization_epoch > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz
);
CREATE INDEX webhook_subscriptions_endpoint ON webhook_subscriptions(endpoint_id,id);
CREATE INDEX webhook_subscriptions_project_owner ON webhook_subscriptions(project_id,owner_kind,owner_id,authorization_state,id) WHERE deleted_at IS NULL;

CREATE TABLE webhook_bindings (
    id uuid PRIMARY KEY,
    subscription_id uuid NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('task.created','task.status_changed','task.paused','task.deleted','task.step_updated','task.thread_posted')),
    created_at timestamptz NOT NULL,
    deleted_at timestamptz
);
CREATE UNIQUE INDEX webhook_bindings_active_selection ON webhook_bindings(subscription_id,event_type) WHERE deleted_at IS NULL;
CREATE INDEX webhook_bindings_subscription ON webhook_bindings(subscription_id,id);

CREATE TABLE webhook_signing_keys (
    id uuid PRIMARY KEY,
    endpoint_id uuid NOT NULL,
    encrypted_secret bytea NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz,
    revoked_at timestamptz
);
CREATE UNIQUE INDEX webhook_signing_keys_active ON webhook_signing_keys(endpoint_id) WHERE revoked_at IS NULL AND expires_at IS NULL;
CREATE INDEX webhook_signing_keys_endpoint ON webhook_signing_keys(endpoint_id,id);

CREATE TABLE webhook_operations (
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal','team')),
    owner_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_user_id uuid NOT NULL,
    kind text NOT NULL,
    issued_at text NOT NULL,
    request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint)=32),
    endpoint_id uuid NOT NULL,
    effect text NOT NULL CHECK (effect IN ('applied','unchanged')),
    config_version_after bigint NOT NULL CHECK (config_version_after > 0),
    destination_revision_after bigint NOT NULL CHECK (destination_revision_after > 0),
    delivery_id uuid,
    generation_after bigint,
    key_id uuid,
    signing_overlap_until timestamptz,
    recorded_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > recorded_at),
    PRIMARY KEY(owner_kind,owner_id,operation_id)
);
CREATE INDEX webhook_operations_expiry ON webhook_operations(expires_at,owner_kind,owner_id,operation_id);

CREATE TABLE webhook_quota_buckets (
    bucket smallint PRIMARY KEY CHECK (bucket BETWEEN 0 AND 15),
    records_used bigint NOT NULL DEFAULT 0 CHECK (records_used >= 0),
    bytes_used bigint NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
    active_records_used bigint NOT NULL DEFAULT 0 CHECK (active_records_used >= 0),
    active_bytes_used bigint NOT NULL DEFAULT 0 CHECK (active_bytes_used >= 0),
    operations_used bigint NOT NULL DEFAULT 0 CHECK (operations_used >= 0)
);
INSERT INTO webhook_quota_buckets(bucket) SELECT generate_series(0,15);

CREATE TABLE webhook_quota_owners (
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal','team')),
    owner_id uuid NOT NULL,
    bucket smallint NOT NULL CHECK (bucket BETWEEN 0 AND 15),
    records_used bigint NOT NULL DEFAULT 0 CHECK (records_used >= 0),
    bytes_used bigint NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
    active_records_used bigint NOT NULL DEFAULT 0 CHECK (active_records_used >= 0),
    active_bytes_used bigint NOT NULL DEFAULT 0 CHECK (active_bytes_used >= 0),
    operations_used bigint NOT NULL DEFAULT 0 CHECK (operations_used >= 0),
    PRIMARY KEY(owner_kind,owner_id)
);

CREATE TABLE webhook_policies (
    version bigint PRIMARY KEY CHECK (version > 0),
    parameters bytea NOT NULL,
    sha256 bytea NOT NULL CHECK (octet_length(sha256)=32)
);
INSERT INTO webhook_policies(version,parameters,sha256)
SELECT 1,convert_to(value,'UTF8'),sha256(convert_to(value,'UTF8')) FROM (VALUES
('{"version":1,"endpointLimit":20,"subscriptionsPerEndpoint":50,"bindingsPerSubscription":6,"matchedEndpointsPerProject":256,"storageBuckets":16,"bucketRecordLimit":65536,"bucketBytesLimit":268435456,"bucketActiveRecordLimit":32768,"bucketActiveBytesLimit":134217728,"ownerRecordLimit":32768,"ownerBytesLimit":67108864,"ownerActiveRecordLimit":24576,"ownerActiveBytesLimit":50331648,"operationOwnerLimit":1024,"operationBucketLimit":8192,"operationBytes":4096,"operationRetentionSeconds":2592000,"operationMaxAgeSeconds":300,"operationFutureSkewSeconds":60,"configurationRequestBytesLimit":262144,"automaticAttemptLimit":10,"automaticWindowSeconds":259200,"automaticOffsetsSeconds":[0,60,300,1800,7200,21600,43200,86400,172800,255600],"retryMinimumWaitSeconds":5,"retryJitterPercent":10,"retryJitterMaximumSeconds":1800,"manualAttemptLimit":3,"payloadWindowSeconds":604800,"metadataRetentionSeconds":2592000,"globalLeaseLimit":32,"ownerLeaseLimit":4,"endpointLeaseLimit":1,"workersPerProcess":8,"httpTimeoutSeconds":15,"leaseSeconds":45,"dbOperationSeconds":3,"ownerActiveQueueLimit":1024,"endpointActiveQueueLimit":256,"bucketActiveQueueLimit":4096,"signingOverlapSeconds":86400,"signingMaximumOverlapSeconds":604800,"signingKeyLimit":2,"gcBatchLimit":500,"gcWorkSeconds":2,"gcBusyDelaySeconds":1,"gcIdleDelaySeconds":60,"connectTimeoutSeconds":5,"tlsHandshakeSeconds":5,"responseHeaderSeconds":10,"httpBodyBytesLimit":65536,"httpResponseHeaderBytesLimit":16384,"httpClassificationBytesLimit":2048,"persistedResponseBytesLimit":0,"eventBatchLimit":2,"eventBytesLimit":65536,"recordEnvelopeBytes":2048,"deliveryReservedRecords":63,"nameCharactersLimit":120,"queryCharactersLimit":200,"listDefaultLimit":50,"listMaximumLimit":100,"urlBytesLimit":4096}')) policy(value);
