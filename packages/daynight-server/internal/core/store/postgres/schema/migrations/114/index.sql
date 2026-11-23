CREATE INDEX task_properties_worker_active_claim_idx ON task_properties (
    (((CASE WHEN name='worker' THEN value::jsonb END)->>'userId') COLLATE "C"),
    (((CASE WHEN name='worker' THEN value::jsonb END)->>'workerId') COLLATE "C"),
    task_id
)
WHERE name='worker'
    AND ((CASE WHEN name='worker' THEN value::jsonb END)->>'state') COLLATE "C" = 'active';
