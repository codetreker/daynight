CREATE TABLE goal_dependency_revisions (
    goal_id uuid PRIMARY KEY,
    revision bigint NOT NULL
);

CREATE INDEX goal_dependencies_predecessor
    ON task_dependencies (depends_on_task_id, task_id) WHERE dependency_type = 'goal';

CREATE UNIQUE INDEX goal_dependencies_edge_id
    ON task_dependencies (goal_edge_id) WHERE dependency_type = 'goal';
