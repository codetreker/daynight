package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type ThreadTx struct {
	tx pgx.Tx
}

// WriteThread commits only a successful callback with a live context. Callback
// failures roll back using a fresh bounded cleanup context; ThreadTransactionError
// distinguishes cleanup failures from an unconfirmed COMMIT. Callers must acquire
// Task, credential, project authorization and head locks in that order, without
// a Project lock.
func (s *Store) WriteThread(ctx context.Context, operation func(*ThreadTx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return queryError("begin thread write", err)
	}
	return writeThread(ctx, tx, operation)
}

func writeThread(ctx context.Context, tx pgx.Tx, operation func(*ThreadTx) error) (err error) {
	stage := &ThreadTransactionError{Phase: "callback"}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		if rollbackErr := tx.Rollback(cleanup); rollbackErr != nil && rollbackErr != pgx.ErrTxClosed {
			stage.Phase, stage.RollbackFailed = "rollback", true
			stage.Cause = errors.Join(stage.Cause, rollbackErr)
			err = stage
		}
	}()
	if cause := operation(&ThreadTx{tx: tx}); cause != nil {
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
		stage.OutcomeUnknown = !errors.Is(cause, pgx.ErrTxCommitRollback)
		return stage
	}
	return nil
}
