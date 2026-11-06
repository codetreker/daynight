CREATE TABLE oauth_authorizations (
    id uuid PRIMARY KEY,
    binding_hash bytea NOT NULL CHECK (octet_length(binding_hash) = 32),
    client_snapshot jsonb NOT NULL,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    resource text NOT NULL,
    scope text NOT NULL,
    challenge text NOT NULL,
    state text NOT NULL,
    state_present boolean NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
    user_id uuid,
    grant_id uuid,
    code_hash bytea UNIQUE CHECK (code_hash IS NULL OR octet_length(code_hash) = 32),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    code_expires_at timestamptz,
    retain_until timestamptz NOT NULL
);
CREATE INDEX oauth_authorizations_pending ON oauth_authorizations (expires_at) WHERE status = 'pending';
CREATE INDEX oauth_authorizations_retention ON oauth_authorizations (retain_until, id);
