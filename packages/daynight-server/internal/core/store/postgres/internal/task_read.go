package pg

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func ReadTaskWithLock(ctx context.Context, tx pgx.Tx, projectID, id, lock string) (model.Task, error) {
	task, err := ScanTask(LiveTaskRow{tx.QueryRow(ctx, `SELECT `+TaskProjection+`, t.deleted_at FROM tasks t
  WHERE t.project_id = $1 AND t.id = $2`+lock, projectID, id)})
	if err != nil {
		return model.Task{}, QueryError("read task", err)
	}
	values, err := LoadTaskProperties(ctx, tx, []string{id})
	if err != nil {
		return model.Task{}, err
	}
	task.Properties = values[id]
	return task, nil
}
