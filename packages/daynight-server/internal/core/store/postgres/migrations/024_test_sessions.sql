ALTER TABLE task_sessions
 ADD COLUMN scope text NOT NULL DEFAULT 'task',
 ADD COLUMN test_execution_id uuid,
 ADD COLUMN draining_timeline_seq bigint,
 ALTER COLUMN project_id DROP NOT NULL,
 ALTER COLUMN task_id DROP NOT NULL,
 ALTER COLUMN claim_id DROP NOT NULL,
 ADD CONSTRAINT session_scope_binding CHECK (
  (scope='task' AND project_id IS NOT NULL AND task_id IS NOT NULL AND claim_id IS NOT NULL AND test_execution_id IS NULL)
  OR (scope='test' AND project_id IS NULL AND task_id IS NULL AND claim_id IS NULL AND test_execution_id IS NOT NULL)
 );
CREATE UNIQUE INDEX test_session_registration ON task_sessions(owner_user_id,registration_id) WHERE scope='test';
CREATE UNIQUE INDEX test_session_execution ON task_sessions(owner_user_id,test_execution_id) WHERE scope='test';
