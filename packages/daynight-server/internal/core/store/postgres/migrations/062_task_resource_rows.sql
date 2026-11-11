CREATE VIEW task_resource_rows AS
SELECT t.id, t.project_id, t.title, t.description, t.status, t.version,
       t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents,
       t.required_platform, t.deleted_at, t.assigned_to, t.cancelled_at,
       t.type, t.parent_id, p.type AS parent_type, p.deleted_at AS parent_deleted_at,
       COALESCE(t.deleted_at, CASE WHEN t.type = 'task' AND p.type = 'goal' THEN p.deleted_at END) AS effective_deleted_at
FROM tasks t
LEFT JOIN tasks p ON p.project_id = t.project_id AND p.id = t.parent_id;
