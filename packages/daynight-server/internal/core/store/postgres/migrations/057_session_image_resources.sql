-- Keep legacy inline resources intact until their external closure is verified.
ALTER TABLE session_resources ADD COLUMN blob_id uuid;
ALTER TABLE session_resources ADD COLUMN gc_pending boolean NOT NULL DEFAULT false;
ALTER TABLE session_resources ADD COLUMN blob_path text;
ALTER TABLE session_resources ADD COLUMN migration_id uuid;
CREATE TABLE session_resource_state (
 session_id uuid PRIMARY KEY,
 delete_epoch bigint NOT NULL DEFAULT 0,
 deleting boolean NOT NULL DEFAULT false
);
CREATE TABLE session_image_uploads (
 session_id uuid NOT NULL,
 upload_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 image_id uuid NOT NULL,
 blob_id uuid NOT NULL,
 spec jsonb NOT NULL,
 receipt jsonb NOT NULL,
 expires_at timestamptz NOT NULL, storage_released boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,upload_id), UNIQUE(session_id,blob_id)
);
CREATE TABLE session_image_chunks (
 session_id uuid NOT NULL, upload_id uuid NOT NULL,
 chunk_offset bigint NOT NULL,
 byte_length bigint NOT NULL,
 sha256 text NOT NULL,
 blob_path text NOT NULL,
 PRIMARY KEY(session_id,upload_id,chunk_offset)
);
CREATE TABLE session_image_captures (
 session_id uuid NOT NULL,
 capture_id uuid NOT NULL, image_id uuid NOT NULL,
 request jsonb NOT NULL, receipt jsonb NOT NULL, validated jsonb,
 PRIMARY KEY(session_id,capture_id), UNIQUE(session_id,image_id)
);
CREATE TABLE session_resource_references (
 session_id uuid NOT NULL, resource_id uuid NOT NULL,
 kind text NOT NULL,
 reference_id text NOT NULL,
 PRIMARY KEY(session_id,resource_id,kind,reference_id)
);
-- Leases have no expiry: a stale clock is never proof a writer or reader joined.
CREATE TABLE session_resource_leases (
 session_id uuid NOT NULL,
 lease_id uuid NOT NULL, owner_id uuid NOT NULL, kind text NOT NULL,
 resource_id uuid, delete_epoch bigint NOT NULL,
 PRIMARY KEY(session_id,lease_id)
);
CREATE INDEX session_resource_leases_owner ON session_resource_leases(owner_id,kind);
CREATE TABLE session_operation_intents (
 session_id uuid NOT NULL, operation_id uuid NOT NULL,
 canonical_bytes bytea NOT NULL,
 PRIMARY KEY(session_id,operation_id)
);
CREATE TABLE session_media_requests (
 session_id uuid NOT NULL,
 request_id uuid NOT NULL, action text NOT NULL,
 fence jsonb NOT NULL, body jsonb NOT NULL,
 result jsonb, error jsonb, complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(session_id,request_id)
);

CREATE UNIQUE INDEX session_image_occurrence_source ON session_image_captures(session_id,(request->'occurrence'->>'sourceKey'));
CREATE UNIQUE INDEX session_image_capture_attempt ON session_image_captures(session_id,(receipt->>'attemptId'));

CREATE TABLE session_source_hashes (
 session_id uuid NOT NULL,
 source_epoch uuid NOT NULL,
 kind text NOT NULL,
 source_seq bigint NOT NULL,
 identity text NOT NULL,
 digest bytea NOT NULL,
 PRIMARY KEY(session_id,source_epoch,kind,identity)
);
