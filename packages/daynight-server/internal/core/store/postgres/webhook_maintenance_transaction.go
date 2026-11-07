package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

// transactWebhookMaintenance keeps transaction cleanup inside the maintenance
// activation's deadline. pgx closes a connection whose rollback fails, and
// pgxpool destroys it instead of returning it to the pool. Without a confirmed
// rollback or commit, the durable outcome remains unknown.
func transactWebhookMaintenance(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) (err error) {
	stage := &store.TransactionError{Phase: "operation", Outcome: store.TransactionUnknown}
	defer func() {
		rollbackErr := tx.Rollback(ctx)
		if rollbackErr != nil && rollbackErr != pgx.ErrTxClosed {
			stage.Phase, stage.CleanupFailed = "cleanup", true
			stage.Cause = errors.Join(stage.Cause, databaseFailure("cleanup", rollbackErr))
			err = stage
		} else if !stage.CommitAttempted && rollbackErr == nil {
			stage.Outcome = store.TransactionNotCommitted
		}
	}()
	if cause := operation(tx); cause != nil {
		stage.Cause = cause
		return stage
	}
	if cause := ctx.Err(); cause != nil {
		stage.Cause = cause
		return stage
	}
	stage.Phase, stage.CommitAttempted = "commit", true
	if cause := tx.Commit(ctx); cause != nil {
		stage.Cause = databaseFailure("commit", cause)
		if errors.Is(cause, pgx.ErrTxCommitRollback) {
			stage.Outcome = store.TransactionNotCommitted
		}
		return stage
	}
	stage.Outcome = store.TransactionCommitted
	return nil
}
