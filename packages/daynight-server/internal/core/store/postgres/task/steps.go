package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

// The prefix bounds data crossing the database boundary even when a title is
// very large. 512 characters suffice to construct a 512-byte UTF-8 preview.
const stepSummaryProjection = `id,position,left(title,512),''::text,status,created_at,updated_at,octet_length(title)>512`

func (s *Reader) TaskStepSummary(ctx context.Context, taskID, stepID string) (store.TaskStepProjection, error) {
	row := s.tx.QueryRow(ctx, `SELECT `+stepSummaryProjection+` FROM task_steps WHERE task_id=$1 AND id=$2`, taskID, stepID)
	var result store.TaskStepProjection
	step := &result.Step
	err := row.Scan(&step.ID, &step.Position, &step.Title, &step.Description, &step.Status, &step.CreatedAt, &step.UpdatedAt, &result.TitleTruncated)
	if err != nil {
		return store.TaskStepProjection{}, pg.QueryError("read task step summary", err)
	}
	step.CreatedAt, step.UpdatedAt = step.CreatedAt.UTC(), step.UpdatedAt.UTC()
	return result, nil
}

func (s *Reader) TaskStepPage(ctx context.Context, taskID string, after int64, limit int, summary bool) ([]store.TaskStepProjection, error) {
	if after < -1 || limit < 1 || limit > 101 {
		return nil, pg.QueryError("read task step page", fmt.Errorf("invalid page bounds"))
	}
	projection := pg.TaskStepProjection + `,false`
	if summary {
		projection = stepSummaryProjection
	}
	rows, err := s.tx.Query(ctx, `SELECT `+projection+` FROM task_steps WHERE task_id=$1 AND position>$2 ORDER BY position LIMIT $3`, taskID, after, limit)
	if err != nil {
		return nil, pg.QueryError("read task step page", err)
	}
	defer rows.Close()
	items := make([]store.TaskStepProjection, 0, limit)
	for rows.Next() {
		var item store.TaskStepProjection
		step := &item.Step
		if err := rows.Scan(&step.ID, &step.Position, &step.Title, &step.Description, &step.Status, &step.CreatedAt, &step.UpdatedAt, &item.TitleTruncated); err != nil {
			return nil, pg.QueryError("read task step page", err)
		}
		step.CreatedAt, step.UpdatedAt = step.CreatedAt.UTC(), step.UpdatedAt.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read task step page", err)
	}
	return items, nil
}
