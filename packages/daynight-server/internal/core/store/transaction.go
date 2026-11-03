package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

const cleanupTimeout = 5 * time.Second

type TransactionOutcome string

const (
	TransactionCommitted    TransactionOutcome = "committed"
	TransactionNotCommitted TransactionOutcome = "not_committed"
	TransactionUnknown      TransactionOutcome = "unknown"
)

// TransactionError preserves completion facts separately from the original
// operation and cleanup causes. An unsuccessful COMMIT is not proof of rollback.
type TransactionError struct {
	Phase           string
	Cause           error
	Outcome         TransactionOutcome
	CommitAttempted bool
	CleanupFailed   bool
}

func (err *TransactionError) Error() string { return "transaction " + err.Phase + " failed" }
func (err *TransactionError) Unwrap() error { return err.Cause }

func transact(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) (err error) {
	stage := &TransactionError{Phase: "operation", Outcome: TransactionUnknown}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		rollbackErr := tx.Rollback(cleanup)
		if rollbackErr != nil && rollbackErr != pgx.ErrTxClosed {
			stage.Phase, stage.CleanupFailed = "cleanup", true
			stage.Cause = errors.Join(stage.Cause, rollbackErr)
			err = stage
		} else if !stage.CommitAttempted && rollbackErr == nil {
			stage.Outcome = TransactionNotCommitted
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
		stage.Cause = cause
		if errors.Is(cause, pgx.ErrTxCommitRollback) {
			stage.Outcome = TransactionNotCommitted
		}
		return stage
	}
	stage.Outcome = TransactionCommitted
	return nil
}
