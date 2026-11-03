package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5"
)

func readTaskHeader(ctx context.Context, tx pgx.Tx, projectID, taskID, lock string) (core.TaskHeader, error) {
	var header core.TaskHeader
	err := tx.QueryRow(ctx, `SELECT project_id::text,id::text,version,deleted_at FROM tasks WHERE project_id=$1 AND id=$2`+lock, projectID, taskID).
		Scan(&header.ProjectID, &header.ID, &header.Version, &header.DeletedAt)
	if err != nil {
		return core.TaskHeader{}, queryError("read task header", err)
	}
	header.DeletedAt = utcTime(header.DeletedAt)
	return header, nil
}

func (s *Snapshot) TaskHeader(ctx context.Context, projectID, taskID string) (core.TaskHeader, error) {
	return readTaskHeader(ctx, s.tx, projectID, taskID, "")
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

func readTaskSteps(ctx context.Context, tx pgx.Tx, taskID string) ([]core.TaskStep, error) {
	rows, err := tx.Query(ctx, `SELECT `+taskStepProjection+` FROM task_steps WHERE task_id=$1 ORDER BY position`, taskID)
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

func (s *Snapshot) TaskSteps(ctx context.Context, taskID string) ([]core.TaskStep, error) {
	return readTaskSteps(ctx, s.tx, taskID)
}

func (tx *ProjectTx) TaskHeader(ctx context.Context, taskID string) (core.TaskHeader, error) {
	return readTaskHeader(ctx, tx.tx, tx.projectID, taskID, " FOR UPDATE")
}

func (tx *ProjectTx) TaskSteps(ctx context.Context, taskID string) ([]core.TaskStep, error) {
	return readTaskSteps(ctx, tx.tx, taskID)
}

// InsertTaskStep shifts positions without changing existing content timestamps.
// The deferred position constraint validates the final dense collection at COMMIT.
func (tx *ProjectTx) InsertTaskStep(ctx context.Context, taskID string, step core.TaskStep) error {
	if _, err := tx.tx.Exec(ctx, `UPDATE task_steps SET position=position+1 WHERE task_id=$1 AND position >= $2`, taskID, step.Position); err != nil {
		return queryError("shift task step positions", err)
	}
	if _, err := tx.tx.Exec(ctx, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		taskID, step.ID, step.Position, step.Title, step.Description, step.Status, step.CreatedAt, step.UpdatedAt); err != nil {
		return queryError("insert task step", err)
	}
	return nil
}

// TouchTask advances the shared revision without changing task policy or Sessions.
func (tx *ProjectTx) TouchTask(ctx context.Context, taskID string, observed time.Time) error {
	result, err := tx.tx.Exec(ctx, `UPDATE tasks SET version=version+1,updated_at=$3 WHERE project_id=$1 AND id=$2`, tx.projectID, taskID, observed)
	if err != nil {
		return queryError("touch task", err)
	}
	if result.RowsAffected() != 1 {
		return queryError("touch task", core.ErrNotFound)
	}
	return nil
}
