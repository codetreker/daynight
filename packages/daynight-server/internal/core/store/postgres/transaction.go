package postgres

import (
	"context"
	"errors"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const cleanupTimeout = 5 * time.Second

func databaseFailure(phase string, cause error) error {
	var driver *pgconn.PgError
	state := ""
	if errors.As(cause, &driver) {
		state = driver.Code
	}
	return &Error{Phase: phase, DatabaseFailure: true, SQLState: state, Cause: cause}
}

func transact(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) (err error) {
	return transactMode(ctx, tx, operation, false, false)
}

func transactReadOnly(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) error {
	return transactMode(ctx, tx, operation, true, false)
}

// Signal reception has an end-to-end deadline. Failed rollback closes the pgx
// connection, so cleanup must not continue past that deadline on the HTTP path.
func transactSignal(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error) error {
	return transactMode(ctx, tx, operation, false, true)
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

func transactMode(ctx context.Context, tx pgx.Tx, operation func(pgx.Tx) error, readOnly, boundCleanup bool) (err error) {
	stage := &TransactionError{Phase: "operation", Outcome: TransactionUnknown}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		if deadline, ok := ctx.Deadline(); boundCleanup && ok {
			var stop context.CancelFunc
			cleanup, stop = context.WithDeadline(cleanup, deadline)
			defer stop()
		}
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
				stage.Cause = errors.Join(stage.Cause, pg.ConfirmedClosedCleanup(rollbackErr))
				stage.Outcome = TransactionNotCommitted
				return
			case <-cleanup.Done():
				rollbackErr = errors.Join(rollbackErr, cleanup.Err())
			}
		}
		if rollbackErr != nil && rollbackErr != pgx.ErrTxClosed {
			stage.Phase, stage.CleanupFailed = "cleanup", true
			stage.Cause = errors.Join(stage.Cause, databaseFailure("cleanup", rollbackErr))
			err = stage
		} else if !stage.CommitAttempted && rollbackErr == nil {
			stage.Outcome = TransactionNotCommitted
		}
	}()
	if cause := operation(tx); cause != nil {
		var driver *pgconn.PgError
		if failed, _ := DatabaseErrorFacts(cause); !failed && errors.As(cause, &driver) {
			cause = databaseFailure("operation", cause)
		}
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
			stage.Outcome = TransactionNotCommitted
		}
		return stage
	}
	stage.Outcome = TransactionCommitted
	return nil
}
