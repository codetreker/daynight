package worker

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func readReviewParticipation(ctx context.Context, tx pgx.Tx, userID, workerID string) (model.WorkerReviewParticipation, error) {
	var participation model.WorkerReviewParticipation
	err := tx.QueryRow(ctx, `SELECT review_enabled,review_version FROM workers WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&participation.Enabled, &participation.Version)
	if err != nil {
		return model.WorkerReviewParticipation{}, pg.QueryError("read worker review participation", err)
	}
	return participation, nil
}

func (s *Reader) WorkerReviewParticipation(ctx context.Context, userID, workerID string) (model.WorkerReviewParticipation, error) {
	return readReviewParticipation(ctx, s.tx, userID, workerID)
}

func (w *Writer) WorkerReviewParticipation(ctx context.Context, userID, workerID string) (model.WorkerReviewParticipation, error) {
	return readReviewParticipation(ctx, w.tx, userID, workerID)
}

func (w *Writer) SetWorkerReviewParticipation(ctx context.Context, userID, workerID string, expected int64, next model.WorkerReviewParticipation) error {
	result, err := w.tx.Exec(ctx, `UPDATE workers SET review_enabled=$4,review_version=$5 WHERE user_id=$1 AND worker_id=$2 AND review_version=$3`, userID, workerID, expected, next.Enabled, next.Version)
	if err != nil {
		return pg.QueryError("save worker review participation", err)
	}
	if result.RowsAffected() != 1 {
		return &model.Fault{Code: "version_conflict", Message: "Worker review participation has changed."}
	}
	return nil
}
