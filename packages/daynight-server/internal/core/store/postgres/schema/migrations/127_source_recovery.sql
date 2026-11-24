-- Recovery identities remain as tombstones even if their Session is removed.
ALTER TABLE task_sessions ADD COLUMN source_recovery_count integer NOT NULL DEFAULT 0 CHECK (source_recovery_count >= 0 AND source_recovery_count <= 4096);
CREATE TABLE session_source_recoveries (
 session_id uuid NOT NULL,
 recovery_id uuid NOT NULL,
 digest bytea NOT NULL CHECK (octet_length(digest) = 32),
 verified_through bigint NOT NULL CHECK (verified_through > 0),
 PRIMARY KEY(session_id,recovery_id)
);
