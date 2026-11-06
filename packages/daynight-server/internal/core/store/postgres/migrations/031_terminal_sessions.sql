-- Both producers share one Session identity and archive namespace.
ALTER TABLE task_sessions
 ADD COLUMN backend text NOT NULL DEFAULT 'web' CHECK (backend IN ('web','herdr')),
 ADD COLUMN terminal_state jsonb,
 ALTER COLUMN snapshot DROP NOT NULL,
 ADD CONSTRAINT session_backend_content CHECK (
   (backend='web' AND snapshot IS NOT NULL AND terminal_state IS NULL)
   OR (backend='herdr' AND scope='task' AND snapshot IS NULL AND terminal_state IS NOT NULL)
 );
CREATE INDEX task_session_history ON task_sessions(project_id,task_id,created_at DESC,id DESC) WHERE scope='task';
ALTER TABLE session_archives
 DROP CONSTRAINT session_archives_state_check,
 DROP CONSTRAINT session_archives_check,
 ADD COLUMN schema_version integer NOT NULL DEFAULT 1,
 ADD COLUMN completeness text,
 ADD COLUMN finalization_id uuid,
 ADD COLUMN receipt jsonb,
 ADD CONSTRAINT session_archive_state CHECK (state IN ('pending','ready','failed','unavailable')),
 ADD CONSTRAINT session_archive_body CHECK (
  (state='ready' AND sha256 ~ '^[a-f0-9]{64}$' AND sha256 IS NOT NULL AND byte_length BETWEEN 1 AND 67108864 AND byte_length IS NOT NULL AND object_path IS NOT NULL AND error_code IS NULL)
  OR (state<>'ready' AND sha256 IS NULL AND byte_length IS NULL AND object_path IS NULL)
 ),
 ADD CONSTRAINT session_archive_version CHECK (
  (schema_version=1 AND state<>'unavailable' AND (state<>'pending' OR error_code IS NULL) AND completeness IS NULL AND finalization_id IS NULL AND receipt IS NULL)
  OR (schema_version=2 AND ((state='ready' AND completeness IN ('complete','partial') AND finalization_id IS NOT NULL AND receipt IS NOT NULL)
    OR (state='unavailable' AND completeness IS NULL AND finalization_id IS NOT NULL AND receipt IS NOT NULL)
    OR (state IN ('pending','failed') AND completeness IS NULL AND receipt IS NULL)))
 );
-- Evidence identities remain replay-safe even after a newer checkpoint arrives.
CREATE TABLE session_recording_evidence (
 session_id uuid NOT NULL,
 execution_generation bigint NOT NULL CHECK (execution_generation>0),
 evidence_id uuid NOT NULL,
 revision bigint NOT NULL CHECK (revision>0),
 body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(session_id,execution_generation,evidence_id),
 UNIQUE(session_id,execution_generation,revision)
);
