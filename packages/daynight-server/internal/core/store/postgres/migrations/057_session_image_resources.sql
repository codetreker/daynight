-- Keep legacy inline resources intact until their external closure is verified.
ALTER TABLE session_resources ADD COLUMN blob_id uuid;
ALTER TABLE session_resources ADD COLUMN blob_path text;
ALTER TABLE session_resources ADD COLUMN migration_id uuid;
ALTER TABLE session_resources ADD CONSTRAINT session_resource_blob_pair CHECK ((blob_id IS NULL) = (blob_path IS NULL));
CREATE TABLE session_resource_state (
 session_id uuid PRIMARY KEY REFERENCES task_sessions(id) ON DELETE CASCADE,
 delete_epoch bigint NOT NULL DEFAULT 0 CHECK(delete_epoch>=0),
 deleting boolean NOT NULL DEFAULT false
);
CREATE TABLE session_image_uploads (
 session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
 upload_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 image_id uuid NOT NULL,
 blob_id uuid NOT NULL,
 spec jsonb NOT NULL,
 receipt jsonb NOT NULL,
 expires_at timestamptz NOT NULL, storage_released boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,upload_id), UNIQUE(session_id,blob_id),
 CHECK(receipt->>'state' IN ('receiving','verifying','complete','failed','expired','released'))
);
CREATE TABLE session_image_chunks (
 session_id uuid NOT NULL, upload_id uuid NOT NULL,
 chunk_offset bigint NOT NULL CHECK(chunk_offset>=0),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 524288),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 blob_path text NOT NULL,
 PRIMARY KEY(session_id,upload_id,chunk_offset),
 FOREIGN KEY(session_id,upload_id) REFERENCES session_image_uploads(session_id,upload_id) ON DELETE CASCADE
);
CREATE TABLE session_image_captures (
 session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
 capture_id uuid NOT NULL, image_id uuid NOT NULL,
 request jsonb NOT NULL, receipt jsonb NOT NULL, validated jsonb,
 PRIMARY KEY(session_id,capture_id), UNIQUE(session_id,image_id)
);
CREATE TABLE session_resource_references (
 session_id uuid NOT NULL, resource_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('upload','operation','message','unknown','native_resume','archive')),
 reference_id text NOT NULL,
 PRIMARY KEY(session_id,resource_id,kind,reference_id),
 FOREIGN KEY(session_id,resource_id) REFERENCES session_resources(session_id,resource_id) ON DELETE CASCADE
);
-- Leases have no expiry: a stale clock is never proof a writer or reader joined.
CREATE TABLE session_resource_leases (
 session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
 lease_id uuid NOT NULL, owner_id uuid NOT NULL, kind text NOT NULL,
 resource_id uuid, delete_epoch bigint NOT NULL CHECK(delete_epoch>=0),
 PRIMARY KEY(session_id,lease_id),
 CHECK(kind IN ('read','write','archive'))
);
CREATE INDEX session_resource_leases_owner ON session_resource_leases(owner_id,kind);
CREATE TABLE session_operation_intents (
 session_id uuid NOT NULL, operation_id uuid NOT NULL,
 canonical_bytes bytea NOT NULL CHECK(octet_length(canonical_bytes)<=2097152),
 PRIMARY KEY(session_id,operation_id),
 FOREIGN KEY(session_id,operation_id) REFERENCES session_operations(session_id,operation_id) ON DELETE CASCADE
);
CREATE TABLE session_media_requests (
 session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
 request_id uuid NOT NULL, action text NOT NULL,
 fence jsonb NOT NULL, body jsonb NOT NULL,
 result jsonb, error jsonb, complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,request_id),
 CHECK(octet_length(body::text)<=1048576),
 CHECK((complete AND ((result IS NULL) <> (error IS NULL))) OR (NOT complete AND result IS NULL AND error IS NULL))
);

CREATE UNIQUE INDEX session_image_occurrence_source ON session_image_captures(session_id,(request->'occurrence'->>'sourceKey'));
CREATE UNIQUE INDEX session_image_capture_attempt ON session_image_captures(session_id,(receipt->>'attemptId'));

CREATE TABLE session_source_hashes (
 session_id uuid NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
 source_epoch uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('event','batch')),
 source_seq bigint NOT NULL CHECK(source_seq>=0),
 identity text NOT NULL CHECK(octet_length(identity) BETWEEN 1 AND 36),
 digest bytea NOT NULL CHECK(octet_length(digest)=32),
 PRIMARY KEY(session_id,source_epoch,kind,identity)
);
