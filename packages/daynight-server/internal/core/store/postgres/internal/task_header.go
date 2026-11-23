package pg

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

func ReadTaskHeader(ctx context.Context, tx pgx.Tx, projectID, taskID, lock string) (model.TaskHeader, error) {
	var header model.TaskHeader
	relation, deleted := "task_resource_rows t", "t.effective_deleted_at"
	if lock != "" {
		relation, deleted = "tasks t", "COALESCE(t.deleted_at, t.ancestor_deleted_at)"
		lock += " OF t"
	}
	err := tx.QueryRow(ctx, `SELECT t.project_id::text,t.id::text,t.type,t.version,`+deleted+` FROM `+relation+` WHERE t.project_id=$1 AND t.id=$2`+lock, projectID, taskID).
		Scan(&header.ProjectID, &header.ID, &header.Type, &header.Version, &header.DeletedAt)
	if err != nil {
		return model.TaskHeader{}, QueryError("read task header", err)
	}
	header.DeletedAt = UTCTime(header.DeletedAt)
	return header, nil
}
