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

// These are exactly the code points accepted by Go's unicode.IsSpace. Checking
// the complete title before withholding text prevents an oversized historical
// record from hiding an invalid all-whitespace title.
const stepWhitespace = `chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(133)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)`

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
	// Do not transfer a historical row whose raw text alone cannot fit the
	// largest MCP Step page. JSON encoding cannot make these bytes smaller.
	projection := `id,position,
		CASE WHEN octet_length(title)+octet_length(description)>4194304 THEN '' ELSE title END,
		CASE WHEN octet_length(title)+octet_length(description)>4194304 THEN '' ELSE description END,
		status,created_at,updated_at,false,octet_length(title)+octet_length(description)>4194304`
	if summary {
		projection = stepSummaryProjection + `,false`
	}
	projection += `,btrim(title,` + stepWhitespace + `)=''`
	rows, err := s.tx.Query(ctx, `SELECT `+projection+` FROM task_steps WHERE task_id=$1 AND position>$2 ORDER BY position LIMIT $3`, taskID, after, limit)
	if err != nil {
		return nil, pg.QueryError("read task step page", err)
	}
	defer rows.Close()
	items := make([]store.TaskStepProjection, 0, limit)
	for rows.Next() {
		var item store.TaskStepProjection
		step := &item.Step
		if err := rows.Scan(&step.ID, &step.Position, &step.Title, &step.Description, &step.Status, &step.CreatedAt, &step.UpdatedAt, &item.TitleTruncated, &item.Oversized, &item.InvalidTitle); err != nil {
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
