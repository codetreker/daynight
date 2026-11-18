package worker

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func readAlias(ctx context.Context, tx pgx.Tx, userID, workerID string) (model.WorkerAlias, error) {
	var alias model.WorkerAlias
	err := tx.QueryRow(ctx, `SELECT alias_value,alias_version FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&alias.Value, &alias.Version)
	if err != nil {
		return model.WorkerAlias{}, pg.QueryError("read worker alias", err)
	}
	return alias, nil
}

func (s *Reader) WorkerAlias(ctx context.Context, userID, workerID string) (model.WorkerAlias, error) {
	return readAlias(ctx, s.tx, userID, workerID)
}

func (w *Writer) WorkerAlias(ctx context.Context, userID, workerID string) (model.WorkerAlias, error) {
	return readAlias(ctx, w.tx, userID, workerID)
}

func (w *Writer) SetWorkerAlias(ctx context.Context, userID, workerID string, expected int64, next model.WorkerAlias) error {
	result, err := w.tx.Exec(ctx, `UPDATE workers SET alias_value=$4,alias_version=$5 WHERE user_id=$1 AND worker_id=$2 AND alias_version=$3`, userID, workerID, expected, next.Value, next.Version)
	if err != nil {
		return pg.QueryError("save worker alias", err)
	}
	if result.RowsAffected() != 1 {
		return &model.Fault{Code: "version_conflict", Message: "Worker alias has changed."}
	}
	return nil
}
