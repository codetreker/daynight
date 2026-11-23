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
