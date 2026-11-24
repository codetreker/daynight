-- Freeze dispatch receipts and Worker intent until the cutover commits.
LOCK TABLE session_operations, worker_lifecycle IN ACCESS EXCLUSIVE MODE;

-- An offer precedes the server's dispatch authorization. Reject only unsent
-- commands that the retired fence would refuse, preserving later receipts.
WITH pending AS (
    SELECT operation.session_id, operation.operation_id, operation.worker_id,
           operation.worker_intent_version, session.owner_user_id,
           COALESCE(recovery.worker_id::text, bot.worker_id::text,
                    session.snapshot #>> '{identity,workerId}') AS current_worker_id
    FROM session_operations AS operation
    JOIN task_sessions AS session ON session.id = operation.session_id
    LEFT JOIN bots AS bot ON bot.id = session.bot_id
        AND bot.session_id = session.id AND bot.owner_user_id = session.owner_user_id
    LEFT JOIN bot_recovery AS recovery ON recovery.bot_id = bot.id
    WHERE operation.receipt->>'state' IN ('accepted', 'offered')
      AND operation.command->>'kind' IN ('send_message', 'interaction_response',
                                         'update_setting', 'execute_command', 'refresh_controls')
      AND session.backend = 'web'
      AND (session.bot_id IS NULL OR bot.id IS NOT NULL)
)
UPDATE session_operations AS operation
SET receipt = operation.receipt || '{
    "state": "rejected",
    "error": {
        "code": "permission_or_state_changed",
        "message": "Worker stopped accepting execution before dispatch."
    }
}'::jsonb
FROM pending
LEFT JOIN worker_lifecycle AS lifecycle
    ON lifecycle.user_id = pending.owner_user_id
    AND lifecycle.worker_id::text = pending.current_worker_id
WHERE operation.session_id = pending.session_id
  AND operation.operation_id = pending.operation_id
  AND NULLIF(pending.current_worker_id, '') IS NOT NULL
  AND (lifecycle.admission = 'closed'
       OR pending.worker_intent_version IS DISTINCT FROM lifecycle.intent_version
       OR (pending.worker_id IS NOT NULL AND pending.worker_id::text <> pending.current_worker_id));

DROP TABLE worker_lifecycle_observations, worker_lifecycle_operations, worker_lifecycle;

ALTER TABLE session_operations
    DROP COLUMN worker_intent_version,
    DROP COLUMN worker_id;
