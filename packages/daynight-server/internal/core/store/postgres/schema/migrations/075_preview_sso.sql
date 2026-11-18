ALTER TABLE sessions ADD COLUMN preview_token_hash bytea;
CREATE UNIQUE INDEX sessions_preview_token_hash ON sessions (preview_token_hash) WHERE preview_token_hash IS NOT NULL;

CREATE TABLE preview_sso_logins (
    id uuid PRIMARY KEY,
    return_url text NOT NULL,
    expires_at timestamptz NOT NULL,
    state_hash bytea,
    code_hash bytea,
    session_id uuid
);
CREATE UNIQUE INDEX preview_sso_logins_code_hash ON preview_sso_logins (code_hash) WHERE code_hash IS NOT NULL;
CREATE INDEX preview_sso_logins_expiry ON preview_sso_logins (expires_at);
