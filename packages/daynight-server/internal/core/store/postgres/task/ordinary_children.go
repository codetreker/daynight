package task

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (tx *Writer) UnfinishedChildIDs(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT id::text FROM tasks
		WHERE project_id=$1 AND parent_id=$2 AND type='task'
		AND COALESCE(deleted_at,ancestor_deleted_at) IS NULL
		AND status NOT IN ('done','cancelled') ORDER BY id`, tx.projectID, id)
	if err != nil {
		return nil, pg.QueryError("read unfinished child tasks", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, pg.QueryError("read unfinished child tasks", err)
	}
	return ids, nil
}
