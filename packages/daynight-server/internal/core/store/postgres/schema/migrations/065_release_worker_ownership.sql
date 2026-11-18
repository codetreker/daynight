WITH affected AS MATERIALIZED (
    SELECT task_id
    FROM task_properties
    WHERE name = 'worker'
      AND value::jsonb ->> 'state' = 'released'
),
removed AS (
    DELETE FROM task_properties
    WHERE task_id IN (SELECT task_id FROM affected)
      AND name IN ('worker', 'sessionStartup')
),
changed AS (
    UPDATE tasks
    SET version = version + 1,
        updated_at = statement_timestamp()
    WHERE id IN (SELECT task_id FROM affected)
    RETURNING project_id
)
UPDATE projects
SET task_cache_epoch = gen_random_uuid()
WHERE id IN (SELECT project_id FROM changed);
