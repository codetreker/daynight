package postgres

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/reviewassignment"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Snapshot) ReviewAssignment(ctx context.Context, userID, projectID string, repoID, prID int64) (*store.ReviewAssignment, error) {
	return reviewassignment.NewReader(s.tx).ReviewAssignment(ctx, userID, projectID, repoID, prID)
}
func (s *Snapshot) ReviewPollWorker(ctx context.Context, userID, workerID string) (*store.ReviewPollWorker, error) {
	return reviewassignment.NewReader(s.tx).ReviewPollWorker(ctx, userID, workerID)
}
func (s *Snapshot) ReviewPollCandidates(ctx context.Context, userID, workerID string, projectIDs []string, after *store.ReviewPollKey, limit int) ([]store.ReviewPollCandidate, error) {
	return reviewassignment.NewReader(s.tx).ReviewPollCandidates(ctx, userID, workerID, projectIDs, after, limit)
}
func (s *Store) ReviewScanStart(ctx context.Context) (time.Time, *store.ReviewWorkerKey, error) {
	return reviewassignment.NewReader(s.Pool).ReviewScanStart(ctx)
}
func (s *Store) ReviewWorkers(ctx context.Context, start time.Time, upper store.ReviewWorkerKey, after *store.ReviewWorkerKey, limit int) ([]store.ReviewWorker, error) {
	return reviewassignment.NewReader(s.Pool).ReviewWorkers(ctx, start, upper, after, limit)
}
func (s *Store) ReviewRepository(ctx context.Context, projectID string) (*int64, error) {
	return reviewassignment.NewReader(s.Pool).ReviewRepository(ctx, projectID)
}
func (s *Store) ReviewOpenPRs(ctx context.Context, userID, projectID string, repoID int64, upper, after *int64, limit int) ([]store.ReviewPR, error) {
	return reviewassignment.NewReader(s.Pool).ReviewOpenPRs(ctx, userID, projectID, repoID, upper, after, limit)
}
func (s *Store) WriteReviewAssignment(ctx context.Context, projectID string, op func(store.ReviewAssignmentWrite) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin review assignment", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, projectID).Scan(&id); err != nil {
			return pg.QueryError("lock review project", err)
		}
		return op(reviewassignment.NewWriter(tx, projectID))
	})
	return teamCompletion("write review assignment", err)
}
