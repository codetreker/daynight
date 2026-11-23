package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var _ store.TaskCascadeCancelDAO = (*Writer)(nil)

func (tx *Writer) TaskCascadeCancel(ctx context.Context, id string) ([]model.Task, error) {
	rows, err := tx.tx.Query(ctx, `WITH RECURSIVE subtree(id) AS (
		SELECT id FROM tasks WHERE project_id=$1 AND id=$2
			AND COALESCE(deleted_at,ancestor_deleted_at) IS NULL
		UNION
		SELECT child.id FROM tasks child JOIN subtree parent ON child.parent_id=parent.id
		WHERE child.project_id=$1 AND COALESCE(child.deleted_at,child.ancestor_deleted_at) IS NULL
	) SELECT t.id::text FROM tasks t JOIN subtree s ON s.id=t.id
	WHERE t.project_id=$1 AND (t.id=$2 OR t.status NOT IN ('done','cancelled'))
	ORDER BY t.id FOR UPDATE OF t`, tx.projectID, id)
	if err != nil {
		return nil, pg.QueryError("lock task cancellation rows", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pg.QueryError("lock task cancellation rows", err)
	}
	if len(ids) == 0 {
		return nil, model.ErrNotFound
	}
	tasks := make([]model.Task, 0, len(ids))
	for _, taskID := range ids {
		current, err := tx.Task(ctx, taskID)
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, current)
	}
	return tasks, nil
}
