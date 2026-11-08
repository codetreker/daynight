CREATE TABLE oauth_grants (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    client_id text NOT NULL CHECK (length(client_id) > 0),
    client_snapshot jsonb NOT NULL,
    resource text NOT NULL CHECK (length(resource) > 0),
    scope text NOT NULL CHECK (length(scope) > 0),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours'),
    revoked_at timestamptz
);
CREATE INDEX oauth_grants_client_active ON oauth_grants (client_id, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX oauth_grants_owner ON oauth_grants (user_id, created_at, id);
CREATE INDEX oauth_grants_expiry ON oauth_grants (expires_at);

CREATE TABLE oauth_access_tokens (
    id uuid PRIMARY KEY,
    grant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '60 minutes')
);
CREATE INDEX oauth_access_tokens_grant ON oauth_access_tokens (grant_id);
CREATE INDEX oauth_access_tokens_expiry ON oauth_access_tokens (expires_at);

CREATE TABLE oauth_refresh_tokens (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    grant_id uuid NOT NULL,
    client_id text NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    consumed_at timestamptz,
    replaced_by_hash bytea CHECK (replaced_by_hash IS NULL OR octet_length(replaced_by_hash) = 32)
);
CREATE INDEX oauth_refresh_tokens_grant ON oauth_refresh_tokens (grant_id);
CREATE INDEX oauth_refresh_tokens_expiry ON oauth_refresh_tokens (expires_at);
