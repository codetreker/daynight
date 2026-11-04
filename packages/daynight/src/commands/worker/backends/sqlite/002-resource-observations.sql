UPDATE executions
SET data = json_remove(data,
  '$.cleanup.input', '$.cleanup.baseline', '$.cleanup.result', '$.cleanup.error',
  '$.cleanup.agentStopped', '$.cleanup.workspaceClosed', '$.cleanup.backendResourcesClosed',
  '$.cleanup.worktreeDeleted', '$.cleanup.mode'
);
