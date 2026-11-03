package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func readTaskHeader(ctx context.Context, tx pgx.Tx, projectID, taskID string) (core.TaskHeader, error) {
	var header core.TaskHeader
	err := tx.QueryRow(ctx, `SELECT project_id::text,id::text,version,deleted_at FROM tasks WHERE project_id=$1 AND id=$2`, projectID, taskID).
		Scan(&header.ProjectID, &header.ID, &header.Version, &header.DeletedAt)
	if err != nil {
		return core.TaskHeader{}, queryError("read task header", err)
	}
	header.DeletedAt = utcTime(header.DeletedAt)
	return header, nil
}

func (s *Snapshot) TaskHeader(ctx context.Context, projectID, taskID string) (core.TaskHeader, error) {
	return readTaskHeader(ctx, s.tx, projectID, taskID)
}

const taskStepProjection = `id,position,title,description,status,created_at,updated_at`

func scanTaskStep(row pgx.Row) (core.TaskStep, error) {
	var step core.TaskStep
	err := row.Scan(&step.ID, &step.Position, &step.Title, &step.Description, &step.Status, &step.CreatedAt, &step.UpdatedAt)
	if err != nil {
		return core.TaskStep{}, err
	}
	step.CreatedAt, step.UpdatedAt = step.CreatedAt.UTC(), step.UpdatedAt.UTC()
	return step, nil
}

func (s *Snapshot) TaskSteps(ctx context.Context, taskID string) ([]core.TaskStep, error) {
	rows, err := s.tx.Query(ctx, `SELECT `+taskStepProjection+` FROM task_steps WHERE task_id=$1 ORDER BY position`, taskID)
	if err != nil {
		return nil, queryError("read task steps", err)
	}
	defer rows.Close()
	steps := make([]core.TaskStep, 0)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, queryError("read task steps", err)
		}
		step, err := scanTaskStep(rows)
		if err != nil {
			return nil, queryError("read task steps", err)
		}
		steps = append(steps, step)
	}
	if err := rows.Err(); err != nil {
		return nil, queryError("read task steps", err)
	}
	return steps, nil
}

func (s *Snapshot) TaskStep(ctx context.Context, taskID, stepID string) (core.TaskStep, error) {
	step, err := scanTaskStep(s.tx.QueryRow(ctx, `SELECT `+taskStepProjection+` FROM task_steps WHERE task_id=$1 AND id=$2`, taskID, stepID))
	if err != nil {
		return core.TaskStep{}, queryError("read task step", err)
	}
	return step, nil
}
