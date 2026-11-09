-- Native archives share one external resource model. Herdr schema2 is unchanged.
-- Preserve the historical schema1/2 checks without adding schema3 business rules.
ALTER TABLE session_archives DROP CONSTRAINT session_archive_body;
ALTER TABLE session_archives ADD CONSTRAINT session_archive_body CHECK (
 schema_version=3 OR
 (state='ready' AND sha256 ~ '^[a-f0-9]{64}$' AND sha256 IS NOT NULL AND byte_length BETWEEN 1 AND 67108864 AND byte_length IS NOT NULL AND object_path IS NOT NULL AND error_code IS NULL)
 OR (state<>'ready' AND sha256 IS NULL AND byte_length IS NULL AND object_path IS NULL)
);
ALTER TABLE session_archives DROP CONSTRAINT session_archive_version;
ALTER TABLE session_archives ADD CONSTRAINT session_archive_version CHECK (
 schema_version=3 OR
 (schema_version=1 AND state<>'unavailable' AND (state<>'pending' OR error_code IS NULL) AND completeness IS NULL AND finalization_id IS NULL AND receipt IS NULL)
 OR (schema_version=2 AND ((state='ready' AND completeness IN ('complete','partial') AND finalization_id IS NOT NULL AND receipt IS NOT NULL)
   OR (state='unavailable' AND completeness IS NULL AND finalization_id IS NOT NULL AND receipt IS NOT NULL)
   OR (state IN ('pending','failed') AND completeness IS NULL AND receipt IS NULL)))
);
CREATE TABLE session_archive_bundles (
 session_id uuid PRIMARY KEY,
 prepare_id uuid NOT NULL UNIQUE,
 phase text NOT NULL,
 revision bigint NOT NULL,
 identity jsonb NOT NULL,
 resources jsonb NOT NULL DEFAULT '[]',
 ledger jsonb NOT NULL DEFAULT '{}',
 history_id uuid,
 timeline_id uuid,
 manifest_path text NOT NULL DEFAULT '',
 manifest_hash text NOT NULL DEFAULT '',
 manifest_length text NOT NULL DEFAULT ''
);
CREATE TABLE session_archive_files (
 session_id uuid NOT NULL,
 file_id uuid NOT NULL,
 purpose text NOT NULL,
 timeline_revision bigint NOT NULL DEFAULT 1,
 staging_released boolean NOT NULL DEFAULT false,
 resource jsonb NOT NULL DEFAULT 'null',
 sha256 text NOT NULL,
 byte_length bigint NOT NULL,
 accepted_offset bigint NOT NULL,
 state text NOT NULL,
 object_path text NOT NULL,
 PRIMARY KEY(session_id,file_id)
);
CREATE UNIQUE INDEX session_archive_one_receiving_file ON session_archive_files(session_id) WHERE state='receiving';
CREATE TABLE session_archive_chunks (
 session_id uuid NOT NULL, file_id uuid NOT NULL,
 chunk_offset bigint NOT NULL, byte_length bigint NOT NULL,
 sha256 text NOT NULL, object_path text NOT NULL,
 PRIMARY KEY(session_id,file_id,chunk_offset)
);
CREATE TABLE session_archive_migrations (
 session_id uuid PRIMARY KEY,
 migration_id uuid NOT NULL UNIQUE,
 source_path text NOT NULL,
 source_hash text NOT NULL,
 source_byte_length bigint NOT NULL,
 target_path text NOT NULL DEFAULT '',
 target_hash text NOT NULL DEFAULT '',
 phase text NOT NULL
);
