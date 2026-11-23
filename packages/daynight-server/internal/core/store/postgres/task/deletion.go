package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// Every member is locked at its final write strength. Resource operations can
// already hold SHARE locks on these rows, so upgrades after another Task lock
// would reverse their acquisition order.
func (tx *Writer) TaskForDeletion(ctx context.Context, id string, removeDepends bool) (model.Task, error) {
	rows, err := tx.tx.Query(ctx, `WITH RECURSIVE subtree(id) AS (
		SELECT id FROM tasks WHERE project_id=$1 AND id=$2
			AND COALESCE(deleted_at,ancestor_deleted_at) IS NULL
		UNION
		SELECT child.id FROM tasks child JOIN subtree parent ON child.parent_id=parent.id
		WHERE child.project_id=$1 AND COALESCE(child.deleted_at,child.ancestor_deleted_at) IS NULL
	), affected(id) AS (
		SELECT id FROM subtree
		UNION SELECT task_id FROM task_dependencies
		WHERE $3::boolean AND project_id=$1 AND depends_on_task_id=$2 AND dependency_type='task'
	)
	SELECT t.id::text FROM tasks t JOIN affected a ON a.id=t.id
	WHERE t.project_id=$1 ORDER BY t.id FOR UPDATE OF t`, tx.projectID, id, removeDepends)
	if err != nil {
		return model.Task{}, pg.QueryError("lock task deletion rows", err)
	}
	if _, err := pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		return model.Task{}, pg.QueryError("lock task deletion rows", err)
	}
	return tx.Task(ctx, id)
}

func (tx *Writer) DeleteTask(ctx context.Context, id string, removeDepends bool) (model.TaskTombstone, error) {
	var tombstone model.TaskTombstone
	if _, err := tx.TaskForDeletion(ctx, id, removeDepends); err != nil {
		return tombstone, err
	}
	if removeDepends {
		if _, err := tx.tx.Exec(ctx, `WITH removed AS (
			DELETE FROM task_dependencies WHERE project_id = $1 AND depends_on_task_id = $2 AND dependency_type = 'task'
			RETURNING task_id
		) UPDATE tasks SET version = version + 1, updated_at = statement_timestamp()
		WHERE project_id = $1 AND id IN (SELECT task_id FROM removed)`, tx.projectID, id); err != nil {
			return tombstone, pg.QueryError("remove dependent relationships", err)
		}
	}
	err := tx.tx.QueryRow(ctx, `UPDATE tasks SET deleted_at = statement_timestamp(),
		updated_at = statement_timestamp(), version = version + 1
		WHERE project_id = $1 AND id = $2 AND COALESCE(deleted_at,ancestor_deleted_at) IS NULL
		RETURNING project_id::text, id::text, version, deleted_at`, tx.projectID, id).
		Scan(&tombstone.ProjectID, &tombstone.ID, &tombstone.Version, &tombstone.DeletedAt)
	if err != nil {
		return tombstone, pg.QueryError("delete task", err)
	}
	_, err = tx.tx.Exec(ctx, `WITH RECURSIVE descendants(id) AS (
		SELECT id FROM tasks WHERE project_id=$1 AND parent_id=$2
			AND COALESCE(deleted_at,ancestor_deleted_at) IS NULL
		UNION
		SELECT child.id FROM tasks child JOIN descendants parent ON child.parent_id=parent.id
		WHERE child.project_id=$1 AND COALESCE(child.deleted_at,child.ancestor_deleted_at) IS NULL
	) UPDATE tasks SET ancestor_deleted_at=$3 WHERE project_id=$1 AND id IN (SELECT id FROM descendants)`,
		tx.projectID, id, tombstone.DeletedAt)
	if err != nil {
		return model.TaskTombstone{}, pg.QueryError("hide deleted task descendants", err)
	}
	return tombstone, nil
}
