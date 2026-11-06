CREATE TABLE team_invitations (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL,
    created_by uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    consumed_by uuid,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK ((consumed_by IS NULL) = (consumed_at IS NULL)),
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX team_invitations_team ON team_invitations (team_id, created_at, id);
CREATE INDEX team_invitations_expiry ON team_invitations (team_id, expires_at);
