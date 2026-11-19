package worker

import (
	"context"

	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (s *Reader) WorkerReviewEnabled(ctx context.Context, userID, workerID string) (bool, error) {
	var enabled bool
	err := s.tx.QueryRow(ctx, `SELECT review_enabled FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&enabled)
	if err != nil {
		return false, pg.QueryError("read worker review setting", err)
	}
	return enabled, nil
}

func (w *Writer) SetWorkerReviewEnabled(ctx context.Context, userID, workerID string, enabled bool) (bool, error) {
	var stored bool
	err := w.tx.QueryRow(ctx, `UPDATE workers SET review_enabled=$3 WHERE user_id=$1 AND worker_id=$2 RETURNING review_enabled`, userID, workerID, enabled).Scan(&stored)
	if err != nil {
		return false, pg.QueryError("save worker review setting", err)
	}
	return stored, nil
}
