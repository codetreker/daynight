-- Reject embedded NUL before JSON functions, which can accept a truncated prefix.
-- Invalid and unchanged values are not updated, retaining their original bytes.
UPDATE executions SET data = CASE WHEN instr(data, char(0)) = 0 THEN
    CASE WHEN json_valid(data) THEN
      CASE WHEN json_type(data) = 'object' THEN
        CASE WHEN json_type(data, '$.cleanup') = 'object' THEN
          json_remove(data,
          '$.cleanup.input', '$.cleanup.baseline', '$.cleanup.result', '$.cleanup.error',
          '$.cleanup.agentStopped', '$.cleanup.workspaceClosed', '$.cleanup.backendResourcesClosed',
          '$.cleanup.worktreeDeleted', '$.cleanup.mode')
        ELSE data END
      ELSE data END
    ELSE data END
  ELSE data END
WHERE CASE WHEN instr(data, char(0)) = 0 THEN
    CASE WHEN json_valid(data) THEN
      CASE WHEN json_type(data) = 'object' THEN
        CASE WHEN json_type(data, '$.cleanup') = 'object' THEN
          json_remove(data,
          '$.cleanup.input', '$.cleanup.baseline', '$.cleanup.result', '$.cleanup.error',
          '$.cleanup.agentStopped', '$.cleanup.workspaceClosed', '$.cleanup.backendResourcesClosed',
          '$.cleanup.worktreeDeleted', '$.cleanup.mode') <> json(data)
        ELSE 0 END
      ELSE 0 END
    ELSE 0 END
  ELSE 0 END;
