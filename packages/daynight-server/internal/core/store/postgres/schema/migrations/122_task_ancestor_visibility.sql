ALTER TABLE tasks ADD COLUMN ancestor_deleted_at timestamptz;

DO $$
DECLARE
    invalid record;
BEGIN
    SELECT t.id, t.project_id, t.parent_id,
           CASE
               WHEN t.type NOT IN ('task', 'goal') THEN 'invalid task type'
               WHEN t.type = 'goal' AND t.parent_id IS NOT NULL THEN 'Goal has a parent'
               WHEN p.id IS NULL THEN 'parent does not exist'
               WHEN p.project_id <> t.project_id THEN 'parent belongs to another project'
               WHEN p.type <> 'goal' THEN 'parent is not a Goal'
               WHEN p.parent_id IS NOT NULL THEN 'parent Goal has a parent'
           END AS reason
      INTO invalid
      FROM tasks t
      LEFT JOIN tasks p ON p.id = t.parent_id
     WHERE t.type NOT IN ('task', 'goal')
        OR (t.type = 'goal' AND t.parent_id IS NOT NULL)
        OR (t.parent_id IS NOT NULL AND
            (p.id IS NULL OR p.project_id <> t.project_id OR p.type <> 'goal' OR p.parent_id IS NOT NULL))
     ORDER BY t.id
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'Task ancestor visibility migration rejected historical hierarchy: %', invalid.reason
            USING ERRCODE = 'DN120',
                  DETAIL = format('task=%s project=%s parent=%s', invalid.id, invalid.project_id, invalid.parent_id);
    END IF;
END
$$;

UPDATE tasks t
   SET ancestor_deleted_at = p.deleted_at
  FROM tasks p
 WHERE t.project_id = p.project_id AND t.parent_id = p.id
   AND t.type = 'task' AND p.type = 'goal'
   AND t.deleted_at IS NULL AND p.deleted_at IS NOT NULL;

CREATE OR REPLACE VIEW task_resource_rows AS
SELECT t.id, t.project_id, t.title, t.description, t.status, t.version,
       t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents,
       t.required_platform, t.deleted_at, t.assigned_to, t.cancelled_at,
       t.type, t.parent_id, p.type AS parent_type, p.deleted_at AS parent_deleted_at,
       COALESCE(t.deleted_at, t.ancestor_deleted_at) AS effective_deleted_at
FROM tasks t
LEFT JOIN tasks p ON p.project_id = t.project_id AND p.id = t.parent_id;
