-- Native archives share one external resource model. Herdr schema2 is unchanged.
ALTER TABLE session_archives DROP CONSTRAINT session_archive_body;
ALTER TABLE session_archives ADD CONSTRAINT session_archive_body CHECK (
 (state='ready' AND sha256 ~ '^[a-f0-9]{64}$' AND sha256 IS NOT NULL AND byte_length BETWEEN 1 AND CASE WHEN schema_version=3 THEN 4194304 ELSE 67108864 END AND object_path IS NOT NULL AND error_code IS NULL)
 OR (state<>'ready' AND sha256 IS NULL AND byte_length IS NULL AND object_path IS NULL)
);
ALTER TABLE session_archives DROP CONSTRAINT session_archive_version;
ALTER TABLE session_archives ADD CONSTRAINT session_archive_version CHECK (
 (schema_version=1 AND state<>'unavailable' AND (state<>'pending' OR error_code IS NULL) AND completeness IS NULL AND finalization_id IS NULL AND receipt IS NULL)
 OR (schema_version=2 AND ((state='ready' AND completeness IN ('complete','partial') AND finalization_id IS NOT NULL AND receipt IS NOT NULL) OR (state='unavailable' AND completeness IS NULL AND finalization_id IS NOT NULL AND receipt IS NOT NULL) OR (state IN ('pending','failed') AND completeness IS NULL AND receipt IS NULL)))
 OR (schema_version=3 AND finalization_id IS NULL AND receipt IS NULL AND ((state='ready' AND completeness IN ('complete','partial')) OR (state<>'ready' AND completeness IS NULL)))
);
CREATE TABLE session_archive_bundles (
 session_id uuid PRIMARY KEY,
 prepare_id uuid NOT NULL UNIQUE,
 phase text NOT NULL CHECK (phase IN ('active','settling','sealed','committed','verified','failed')),
 revision bigint NOT NULL CHECK (revision>0),
 identity jsonb NOT NULL CHECK (jsonb_typeof(identity)='object' AND octet_length(identity::text)<=32768),
 resources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(resources)='array' AND octet_length(resources::text)<=4194304),
 ledger jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(ledger)='object' AND octet_length(ledger::text)<=67108864),
 history_id uuid,
 timeline_id uuid,
 manifest_path text NOT NULL DEFAULT '',
 manifest_hash text NOT NULL DEFAULT '' CHECK (manifest_hash='' OR manifest_hash ~ '^[a-f0-9]{64}$'),
 manifest_length text NOT NULL DEFAULT ''
);
CREATE TABLE session_archive_files (
 session_id uuid NOT NULL,
 file_id uuid NOT NULL,
 purpose text NOT NULL CHECK (purpose IN ('history','timeline','resource')),
 timeline_revision bigint NOT NULL DEFAULT 1 CHECK (timeline_revision>0),
 staging_released boolean NOT NULL DEFAULT false,
 resource jsonb NOT NULL DEFAULT 'null',
 sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
 byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 67125248),
 accepted_offset bigint NOT NULL CHECK (accepted_offset>=0 AND accepted_offset<=byte_length),
 state text NOT NULL CHECK (state IN ('receiving','complete','failed')),
 object_path text NOT NULL,
 PRIMARY KEY(session_id,file_id)
);
CREATE UNIQUE INDEX session_archive_one_receiving_file ON session_archive_files(session_id) WHERE state='receiving';
CREATE TABLE session_archive_chunks (
 session_id uuid NOT NULL, file_id uuid NOT NULL,
 chunk_offset bigint NOT NULL CHECK(chunk_offset>=0), byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 1048576),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), object_path text NOT NULL,
 PRIMARY KEY(session_id,file_id,chunk_offset),
 FOREIGN KEY(session_id,file_id) REFERENCES session_archive_files(session_id,file_id)
);
CREATE TABLE session_archive_migrations (
 session_id uuid PRIMARY KEY,
 migration_id uuid NOT NULL UNIQUE,
 source_path text NOT NULL,
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 target_path text NOT NULL DEFAULT '',
 target_hash text NOT NULL DEFAULT '' CHECK (target_hash='' OR target_hash ~ '^[a-f0-9]{64}$'),
 phase text NOT NULL CHECK (phase IN ('prepared','files_durable','committed','verified'))
);
