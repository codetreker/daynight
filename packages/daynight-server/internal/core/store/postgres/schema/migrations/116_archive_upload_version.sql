-- Existing writers and rows retain the original chunk-table protocol.
ALTER TABLE session_archive_files
 ADD COLUMN upload_version integer NOT NULL DEFAULT 1,
 ADD COLUMN prefix_proof bytea,
 ADD COLUMN successor_file_id uuid,
 ADD COLUMN terminal_error jsonb;
