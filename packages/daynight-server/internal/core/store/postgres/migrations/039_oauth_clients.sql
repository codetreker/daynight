CREATE TABLE oauth_clients (
    id text PRIMARY KEY CHECK (length(id) > 0),
    metadata jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX oauth_clients_expiry ON oauth_clients (expires_at, id);
