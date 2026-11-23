UPDATE workers
SET desired_configuration = (desired_configuration - 'preferPlatformSpecificTasks') ||
        jsonb_build_object('platformTaskMode', CASE
            WHEN desired_configuration->'preferPlatformSpecificTasks' = 'true'::jsonb THEN 'prefer'
            ELSE 'all'
        END),
    configuration_revision = configuration_revision + 1,
    configuration_updated_at = statement_timestamp()
WHERE desired_configuration IS NOT NULL
  AND jsonb_typeof(desired_configuration->'preferPlatformSpecificTasks') = 'boolean';
