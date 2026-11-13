package task

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// NewTagWriter binds association operations to the project write transaction.
func NewTagWriter(tx pgx.Tx, projectID string) store.TaskTagWriteDAO {
	return &Writer{tx: tx, projectID: projectID}
}

func (tx *Writer) TaskTags(ctx context.Context, taskID string) ([]model.TagReference, error) {
	return pg.LoadTaskTags(ctx, tx.tx, tx.projectID, taskID)
}

func (tx *Writer) ReplaceTaskTags(ctx context.Context, taskID string, tagIDs []string) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM task_tags WHERE project_id=$1 AND task_id=$2`, tx.projectID, taskID); err != nil {
		return pg.QueryError("replace task tags", err)
	}
	if _, err := tx.tx.Exec(ctx, `INSERT INTO task_tags(project_id, task_id, tag_id)
		SELECT $1::uuid, $2::uuid, id FROM (SELECT DISTINCT unnest($3::uuid[]) AS id) tags`, tx.projectID, taskID, tagIDs); err != nil {
		return pg.QueryError("replace task tags", err)
	}
	return nil
}

func (tx *Writer) TouchTaggedTasks(ctx context.Context, tagID string, observed time.Time) (int64, error) {
	result, err := tx.tx.Exec(ctx, `UPDATE tasks SET version=version+1, updated_at=$3
		WHERE project_id=$1 AND id IN (SELECT task_id FROM task_tags WHERE project_id=$1 AND tag_id=$2)`, tx.projectID, tagID, observed)
	if err != nil {
		return 0, pg.QueryError("touch tagged tasks", err)
	}
	return result.RowsAffected(), nil
}

func (tx *Writer) ClearTagAssociations(ctx context.Context, tagID string) error {
	if _, err := tx.tx.Exec(ctx, `DELETE FROM task_tags WHERE project_id=$1 AND tag_id=$2`, tx.projectID, tagID); err != nil {
		return pg.QueryError("clear tag associations", err)
	}
	return nil
}
