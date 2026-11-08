-- Transaction scopes verify ownership and relationships without implicit FK locks.
CREATE TABLE webhook_subscriptions (
    id uuid PRIMARY KEY,
    endpoint_id uuid NOT NULL,
    project_id uuid NOT NULL,
    owner_kind text NOT NULL CHECK (owner_kind IN ('personal', 'team')),
    owner_id uuid NOT NULL,
    authorization_state text NOT NULL CHECK (authorization_state IN ('active', 'confirmation_required')),
    authorization_epoch bigint NOT NULL CHECK (authorization_epoch > 0),
    created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
    updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
    deleted_at timestamptz CHECK (isfinite(deleted_at))
);
CREATE INDEX webhook_subscriptions_endpoint ON webhook_subscriptions (endpoint_id, id) WHERE deleted_at IS NULL;
CREATE INDEX webhook_subscriptions_acl ON webhook_subscriptions (project_id, owner_kind, owner_id, id) WHERE deleted_at IS NULL;
CREATE INDEX webhook_subscriptions_deleted ON webhook_subscriptions (endpoint_id, deleted_at, id) WHERE deleted_at IS NOT NULL;

CREATE TABLE webhook_bindings (
    id uuid PRIMARY KEY,
    subscription_id uuid NOT NULL,
    event_type text NOT NULL,
    created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
    deleted_at timestamptz CHECK (isfinite(deleted_at))
);
CREATE UNIQUE INDEX webhook_bindings_active ON webhook_bindings (subscription_id, event_type) WHERE deleted_at IS NULL;
CREATE INDEX webhook_bindings_capture ON webhook_bindings (event_type, subscription_id, id) WHERE deleted_at IS NULL;
CREATE INDEX webhook_bindings_deleted ON webhook_bindings (subscription_id, deleted_at, id) WHERE deleted_at IS NOT NULL;
