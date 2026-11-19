ALTER TABLE task_dependencies
    ADD COLUMN dependency_type text NOT NULL DEFAULT 'task',
    ADD COLUMN goal_edge_id uuid;
