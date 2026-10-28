ALTER TABLE task_sessions ADD COLUMN connection_parent_credential_id uuid;
UPDATE task_sessions SET connection_parent_credential_id=parent_credential_id
WHERE (snapshot->>'connectionEpoch')::bigint > 0;
