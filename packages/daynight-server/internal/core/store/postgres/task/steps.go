package task

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) TaskHeader(ctx context.Context, projectID, taskID string) (model.TaskHeader, error) {
	return pg.ReadTaskHeader(ctx, s.tx, projectID, taskID, "")
}

func (s *Reader) TaskStep(ctx context.Context, taskID, stepID string) (model.TaskStep, error) {
	step, err := pg.ScanTaskStep(s.tx.QueryRow(ctx, `SELECT `+pg.TaskStepProjection+` FROM task_steps WHERE task_id=$1 AND id=$2`, taskID, stepID))
	if err != nil {
		return model.TaskStep{}, pg.QueryError("read task step", err)
	}
	return step, nil
}

func (s *Reader) TaskSteps(ctx context.Context, taskID string) ([]model.TaskStep, error) {
	return pg.ReadTaskSteps(ctx, s.tx, taskID)
}
