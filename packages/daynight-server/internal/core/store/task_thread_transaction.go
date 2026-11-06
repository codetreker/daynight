package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type ThreadTx struct {
	tx pgx.Tx
}

func (tx *ThreadTx) TaskDAO() ThreadTaskDAO             { return tx }
func (tx *ThreadTx) CredentialDAO() ThreadCredentialDAO { return tx }
func (tx *ThreadTx) ProjectDAO() ThreadProjectDAO       { return tx }
func (tx *ThreadTx) ThreadDAO() ThreadDAO               { return tx }

// WriteThread takes no Project lock. Callers acquire Task, credential, Project
// authorization and head locks in that order. A lost commit response is unknown.
func (s *Store) WriteThread(ctx context.Context, operation func(ThreadScope) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, queryError("begin thread write", err)
	}
	return writeThread(ctx, tx, operation)
}

func writeThread(ctx context.Context, tx pgx.Tx, operation func(ThreadScope) error) (completion Completion, err error) {
	completion.Outcome = TransactionUnknown
	stage := &ThreadTransactionError{Phase: "callback"}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
		defer cancel()
		rollbackErr := tx.Rollback(cleanup)
		if rollbackErr != nil && rollbackErr != pgx.ErrTxClosed {
			stage.Phase, stage.RollbackFailed = "rollback", true
			stage.Cause = errors.Join(stage.Cause, rollbackErr)
			err = stage
		} else if !stage.CommitAttempted && rollbackErr == nil {
			completion.Outcome = TransactionNotCommitted
		}
	}()
	if cause := operation(&ThreadTx{tx: tx}); cause != nil {
		stage.Cause = cause
		return completion, stage
	}
	if cause := ctx.Err(); cause != nil {
		stage.Cause = cause
		return completion, stage
	}
	stage.Phase, stage.CommitAttempted = "commit", true
	if cause := tx.Commit(ctx); cause != nil {
		stage.Cause = cause
		stage.OutcomeUnknown = !errors.Is(cause, pgx.ErrTxCommitRollback)
		if !stage.OutcomeUnknown {
			completion.Outcome = TransactionNotCommitted
		}
		return completion, stage
	}
	completion.Outcome = TransactionCommitted
	return completion, nil
}
