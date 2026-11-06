package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const cleanupTimeout = 5 * time.Second

func transact(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) (err error) {
	return transactMode(ctx, tx, operation, false)
}

func transactReadOnly(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) error {
	return transactMode(ctx, tx, operation, true)
}

// soleClosed accepts the driver's closed-connection chain but not a joined
// error that could conceal an independent cleanup failure.
func soleClosed(err error) bool {
	for err != nil {
		if err == pgconn.ErrConnClosed {
			return true
		}
		if _, ok := err.(interface{ Unwrap() []error }); ok {
			return false
		}
		err = errors.Unwrap(err)
	}
	return false
}

func transactMode(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error, readOnly bool) (err error) {
	stage := &TransactionError{Phase: "operation", Outcome: TransactionUnknown}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		var closedBefore bool
		var done <-chan struct{}
		if readOnly && !stage.CommitAttempted {
			conn := tx.Conn().PgConn()
			closedBefore, done = conn.IsClosed(), conn.CleanupDone()
		}
		rollbackErr := tx.Rollback(cleanup)
		if closedBefore && soleClosed(rollbackErr) {
			select {
			case <-done:
				stage.Cause = errors.Join(stage.Cause, rollbackErr)
				stage.Outcome = TransactionNotCommitted
				return
			case <-cleanup.Done():
				rollbackErr = errors.Join(rollbackErr, cleanup.Err())
			}
		}
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
