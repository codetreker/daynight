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
	task.Tags, err = LoadTaskTags(ctx, tx, projectID, id)
	if err != nil {
		return model.Task{}, err
	}
	return task, nil
}

// LoadTaskTags reads the current references in the caller's transaction.
func LoadTaskTags(ctx context.Context, tx pgx.Tx, projectID, taskID string) ([]model.TagReference, error) {
	rows, err := tx.Query(ctx, `SELECT p.id::text, p.name FROM task_tags a
		JOIN project_tags p ON p.project_id=a.project_id AND p.id=a.tag_id
		JOIN task_resource_rows t ON t.project_id=a.project_id AND t.id=a.task_id
		WHERE a.project_id=$1 AND a.task_id=$2 AND t.effective_deleted_at IS NULL ORDER BY p.id`, projectID, taskID)
	if err != nil {
		return nil, QueryError("read task tags", err)
	}
	defer rows.Close()
	refs := make([]model.TagReference, 0)
	for rows.Next() {
		var ref model.TagReference
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			return nil, QueryError("read task tags", err)
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, QueryError("read task tags", err)
	}
	return refs, nil
}
