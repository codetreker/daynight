package task

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"time"
)

func (tx *Writer) TaskHeader(ctx context.Context, taskID string) (model.TaskHeader, error) {
	return pg.ReadTaskHeader(ctx, tx.tx, tx.projectID, taskID, " FOR UPDATE")
}

func (tx *Writer) TaskSteps(ctx context.Context, taskID string) ([]model.TaskStep, error) {
	return pg.ReadTaskSteps(ctx, tx.tx, taskID)
}

// InsertTaskStep shifts positions without changing existing content timestamps.
// The deferred position constraint validates the final dense collection at COMMIT.
func (tx *Writer) InsertTaskStep(ctx context.Context, taskID string, step model.TaskStep) error {
	if _, err := tx.tx.Exec(ctx, `UPDATE task_steps SET position=position+1 WHERE task_id=$1 AND position >= $2`, taskID, step.Position); err != nil {
		return pg.QueryError("shift task step positions", err)
	}
	if _, err := tx.tx.Exec(ctx, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		taskID, step.ID, step.Position, step.Title, step.Description, step.Status, step.CreatedAt, step.UpdatedAt); err != nil {
		return pg.QueryError("insert task step", err)
	}
	return nil
}

// TouchTask advances the shared revision without changing task policy or Sessions.
func (tx *Writer) TouchTask(ctx context.Context, taskID string, observed time.Time) error {
	result, err := tx.tx.Exec(ctx, `UPDATE tasks SET version=version+1,updated_at=$3 WHERE project_id=$1 AND id=$2`, tx.projectID, taskID, observed)
	if err != nil {
		return pg.QueryError("touch task", err)
	}
	if result.RowsAffected() != 1 {
		return pg.QueryError("touch task", model.ErrNotFound)
	}
	return nil
}

func (tx *Writer) UpdateTaskStep(ctx context.Context, taskID string, step model.TaskStep) error {
	result, err := tx.tx.Exec(ctx, `UPDATE task_steps SET title=$3,description=$4,status=$5,updated_at=$6 WHERE task_id=$1 AND id=$2`, taskID, step.ID, step.Title, step.Description, step.Status, step.UpdatedAt)
	if err != nil {
		return pg.QueryError("update task step", err)
	}
	if result.RowsAffected() != 1 {
		return pg.QueryError("update task step", model.ErrNotFound)
	}
	return nil
}

// MoveTaskStep changes only the inclusive position interval. The deferred
// uniqueness constraint checks its complete final order at transaction commit.
func (tx *Writer) MoveTaskStep(ctx context.Context, taskID, targetID string, from, to int64) error {
	result, err := tx.tx.Exec(ctx, `UPDATE task_steps SET position=CASE
 WHEN id=$2 THEN $4::bigint
 WHEN $3::bigint < $4::bigint THEN position-1
 ELSE position+1 END
 WHERE task_id=$1 AND position BETWEEN LEAST($3::bigint,$4::bigint) AND GREATEST($3::bigint,$4::bigint)`, taskID, targetID, from, to)
	if err != nil {
		return pg.QueryError("move task step positions", err)
	}
	if result.RowsAffected() != max(from, to)-min(from, to)+1 {
		return pg.QueryError("move task step positions", model.ErrNotFound)
	}
	return nil
}

// DeleteTaskStep releases the current identity and compacts only its retained
// suffix. Both affected counts are checked against the admitted collection.
func (tx *Writer) DeleteTaskStep(ctx context.Context, taskID, targetID string, position, tailCount int64) error {
	deleted, err := tx.tx.Exec(ctx, `DELETE FROM task_steps WHERE task_id=$1 AND id=$2`, taskID, targetID)
	if err != nil {
		return pg.QueryError("delete task step", err)
	}
	if deleted.RowsAffected() != 1 {
		return pg.QueryError("delete task step", model.ErrNotFound)
	}
	compacted, err := tx.tx.Exec(ctx, `UPDATE task_steps SET position=position-1 WHERE task_id=$1 AND position>$2`, taskID, position)
	if err != nil {
		return pg.QueryError("compact task step positions", err)
	}
	if compacted.RowsAffected() != tailCount {
		return pg.QueryError("compact task step positions", model.ErrNotFound)
	}
	return nil
}
