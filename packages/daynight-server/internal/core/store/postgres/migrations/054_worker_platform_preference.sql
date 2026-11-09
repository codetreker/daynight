UPDATE workers
SET desired_configuration = desired_configuration || '{"preferPlatformSpecificTasks":false}'::jsonb
WHERE desired_configuration IS NOT NULL;
