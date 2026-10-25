CREATE TABLE device_authorizations (
    id uuid PRIMARY KEY,
    device_code_hash bytea NOT NULL UNIQUE CHECK (octet_length(device_code_hash) = 32),
    user_code text NOT NULL UNIQUE CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{10}$'),
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    user_id uuid,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    next_poll_at timestamptz NOT NULL,
    poll_interval_seconds integer NOT NULL CHECK (poll_interval_seconds >= 5),
    CHECK ((status = 'pending') = (user_id IS NULL))
);
CREATE INDEX device_authorizations_expiry ON device_authorizations (expires_at);
CREATE TABLE device_authorization_limits (
    bucket_hash bytea PRIMARY KEY CHECK (octet_length(bucket_hash) = 32),
    attempts integer NOT NULL CHECK (attempts > 0),
    expires_at timestamptz NOT NULL
);
CREATE INDEX device_authorization_limits_expiry ON device_authorization_limits (expires_at);
