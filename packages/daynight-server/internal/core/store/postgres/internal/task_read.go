package pg

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func ReadTaskWithLock(ctx context.Context, tx pgx.Tx, projectID, id, lock string) (model.Task, error) {
	relation, deleted := "task_resource_rows", "t.effective_deleted_at"
	if lock != "" {
		relation, deleted = "tasks", "COALESCE(t.deleted_at, (SELECT p.deleted_at FROM tasks p WHERE p.project_id=t.project_id AND p.id=t.parent_id))"
	}
	task, err := ScanTask(LiveTaskRow{tx.QueryRow(ctx, `SELECT `+TaskProjection+`, `+deleted+` FROM `+relation+` t
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
