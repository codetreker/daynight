CREATE TABLE bots (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL REFERENCES users(id),
    worker_id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    creation_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    requested_overrides jsonb NOT NULL CHECK (jsonb_typeof(requested_overrides) = 'object'),
    resolved_configuration jsonb NOT NULL CHECK (jsonb_typeof(resolved_configuration) = 'object'),
    role_configuration jsonb CHECK (jsonb_typeof(role_configuration) = 'object'),
    session_id uuid UNIQUE,
    startup_result jsonb NOT NULL CHECK (jsonb_typeof(startup_result) = 'object'),
    deletion jsonb CHECK (jsonb_typeof(deletion) = 'object'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    FOREIGN KEY (owner_user_id, worker_id) REFERENCES workers(user_id, worker_id)
);
CREATE INDEX bots_owner_list ON bots (owner_user_id, created_at, id) WHERE deletion IS NULL;
CREATE INDEX bots_worker_list ON bots (owner_user_id, worker_id, created_at, id);
