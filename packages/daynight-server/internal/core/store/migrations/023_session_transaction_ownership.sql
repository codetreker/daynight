-- Session ownership follows the existing service transaction contract.
-- Historical session data is retained independently of task lifecycle changes.
ALTER TABLE task_sessions DROP CONSTRAINT task_sessions_project_id_fkey;
ALTER TABLE task_sessions DROP CONSTRAINT task_sessions_task_id_fkey;
ALTER TABLE session_events DROP CONSTRAINT session_events_session_id_fkey;
ALTER TABLE session_timeline DROP CONSTRAINT session_timeline_session_id_fkey;
ALTER TABLE session_operations DROP CONSTRAINT session_operations_session_id_fkey;
ALTER TABLE session_resources DROP CONSTRAINT session_resources_session_id_fkey;
