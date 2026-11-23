UPDATE workers
SET desired_configuration = desired_configuration || '{"enableWindowsProcessCleanup": false}'::jsonb,
    configuration_revision = configuration_revision + 1,
    configuration_updated_at = statement_timestamp()
WHERE desired_configuration IS NOT NULL
  AND NOT (desired_configuration ? 'enableWindowsProcessCleanup');
