-- SQLite JSON functions can accept a prefix before NUL. CASE guards both the
-- complete text and every JSON operation without relying on evaluation order.
UPDATE bots SET record = CASE WHEN instr(record, char(0)) = 0 THEN
    CASE WHEN json_valid(record) THEN
      CASE WHEN json_type(record) = 'object' THEN
        CASE WHEN json_type(record, '$.intent') = 'object' THEN
          CASE WHEN json_type(record, '$.intent.registration') = 'object' THEN
            CASE WHEN json_type(record, '$.intent.registration.controllerInstanceId') IS NOT NULL THEN
              json_set(record,
              '$.intent.controllerInstanceId', json_extract(record, '$.intent.registration.controllerInstanceId'))
            ELSE record END
          ELSE record END
        ELSE record END
      ELSE record END
    ELSE record END
  ELSE record END
WHERE CASE WHEN instr(record, char(0)) = 0 THEN
    CASE WHEN json_valid(record) THEN
      CASE WHEN json_type(record) = 'object' THEN
        CASE WHEN json_type(record, '$.intent') = 'object' THEN
          CASE WHEN json_type(record, '$.intent.registration') = 'object' THEN
            CASE WHEN json_type(record, '$.intent.registration.controllerInstanceId') IS NOT NULL THEN
              json_set(record,
              '$.intent.controllerInstanceId', json_extract(record, '$.intent.registration.controllerInstanceId')) <> json(record)
            ELSE 0 END
          ELSE 0 END
        ELSE 0 END
      ELSE 0 END
    ELSE 0 END
  ELSE 0 END;

UPDATE bot_executions SET record = CASE WHEN instr(record, char(0)) = 0 THEN
    CASE WHEN json_valid(record) THEN
      CASE WHEN json_type(record) = 'object' THEN
        json_set(record,
        '$.recoveryCount', 0,
        '$.restartAfterShutdown', json('false'),
        '$.recoveryBlocked', NULL,
        '$.previous', NULL,
        '$.retainedLaunchIds', json('[]'),
        '$.retainedAliasDirectories', json('[]'))
      ELSE record END
    ELSE record END
  ELSE record END
WHERE CASE WHEN instr(record, char(0)) = 0 THEN
    CASE WHEN json_valid(record) THEN
      CASE WHEN json_type(record) = 'object' THEN
        json_set(record,
        '$.recoveryCount', 0,
        '$.restartAfterShutdown', json('false'),
        '$.recoveryBlocked', NULL,
        '$.previous', NULL,
        '$.retainedLaunchIds', json('[]'),
        '$.retainedAliasDirectories', json('[]')) <> json(record)
      ELSE 0 END
    ELSE 0 END
  ELSE 0 END;
