package pg

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func ReadTaskHeader(ctx context.Context, tx pgx.Tx, projectID, taskID, lock string) (model.TaskHeader, error) {
	var header model.TaskHeader
	err := tx.QueryRow(ctx, `SELECT project_id::text,id::text,version,deleted_at FROM tasks WHERE project_id=$1 AND id=$2`+lock, projectID, taskID).
		Scan(&header.ProjectID, &header.ID, &header.Version, &header.DeletedAt)
	if err != nil {
		return model.TaskHeader{}, QueryError("read task header", err)
	}
	header.DeletedAt = UTCTime(header.DeletedAt)
	return header, nil
}

const TaskStepProjection = `id,position,title,description,status,created_at,updated_at`

func ScanTaskStep(row pgx.Row) (model.TaskStep, error) {
	var step model.TaskStep
	err := row.Scan(&step.ID, &step.Position, &step.Title, &step.Description, &step.Status, &step.CreatedAt, &step.UpdatedAt)
	if err != nil {
		return model.TaskStep{}, err
	}
	step.CreatedAt, step.UpdatedAt = step.CreatedAt.UTC(), step.UpdatedAt.UTC()
	return step, nil
}

func ReadTaskSteps(ctx context.Context, tx pgx.Tx, taskID string) ([]model.TaskStep, error) {
	rows, err := tx.Query(ctx, `SELECT `+TaskStepProjection+` FROM task_steps WHERE task_id=$1 ORDER BY position`, taskID)
	if err != nil {
		return nil, QueryError("read task steps", err)
	}
	defer rows.Close()
	steps := make([]model.TaskStep, 0)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, QueryError("read task steps", err)
		}
		step, err := ScanTaskStep(rows)
		if err != nil {
			return nil, QueryError("read task steps", err)
		}
		steps = append(steps, step)
	}
	if err := rows.Err(); err != nil {
		return nil, QueryError("read task steps", err)
	}
	return steps, nil
}
