-- Session content belongs to file storage; PostgreSQL retains only its manifest.
CREATE TABLE session_archives (
    session_id uuid PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
    sha256 text,
    byte_length bigint,
    object_path text,
    error_code text CHECK (error_code ~ '^[a-z_]{1,64}$'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state = 'ready' AND sha256 IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND byte_length IS NOT NULL AND byte_length BETWEEN 1 AND 67108864 AND object_path IS NOT NULL AND error_code IS NULL)
        OR (state = 'pending' AND sha256 IS NULL AND byte_length IS NULL AND object_path IS NULL AND error_code IS NULL)
        OR (state = 'failed' AND sha256 IS NULL AND byte_length IS NULL AND object_path IS NULL))
);
