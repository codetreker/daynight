CREATE TABLE users (
    id uuid PRIMARY KEY,
    uniauth_id text NOT NULL UNIQUE CHECK (length(uniauth_id) > 0),
    email text,
    email_verified boolean,
    name text,
    avatar_url text,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
);
CREATE TABLE login_transactions (
    id uuid PRIMARY KEY,
    state_hash bytea NOT NULL UNIQUE CHECK (octet_length(state_hash) = 32),
    browser_binding_hash bytea NOT NULL CHECK (octet_length(browser_binding_hash) = 32),
    provider text NOT NULL CHECK (provider IN ('microsoft', 'google', 'github')),
    return_path text NOT NULL CHECK (left(return_path, 1) = '/'),
    expires_at timestamptz NOT NULL
);
CREATE INDEX login_transactions_expiry ON login_transactions (expires_at);
CREATE TABLE sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX sessions_expiry ON sessions (expires_at);
CREATE TABLE personal_access_tokens (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100 AND length(btrim(name)) > 0),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX personal_access_tokens_user ON personal_access_tokens (user_id, created_at, id);
CREATE INDEX personal_access_tokens_expiry ON personal_access_tokens (expires_at);
