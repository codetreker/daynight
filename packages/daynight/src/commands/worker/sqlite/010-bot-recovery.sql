UPDATE bots SET record = json_set(record,
  '$.intent.controllerInstanceId', json_extract(record, '$.intent.registration.controllerInstanceId'))
WHERE json_type(record, '$.intent') = 'object';

UPDATE bot_executions SET record = json_set(record,
  '$.recoveryCount', 0,
  '$.restartAfterShutdown', json('false'),
  '$.recoveryBlocked', NULL,
  '$.previous', NULL,
  '$.retainedLaunchIds', json('[]'),
  '$.retainedAliasDirectories', json('[]'));
