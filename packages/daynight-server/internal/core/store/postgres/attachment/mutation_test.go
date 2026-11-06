package attachment

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type completionTx struct {
	pgx.Tx
	commitErr   error
	rollbackErr error
	commits     int
	rollbacks   int
	cleanupOK   bool
}

func (tx *completionTx) Commit(context.Context) error {
	tx.commits++
	return tx.commitErr
}

func (tx *completionTx) Rollback(ctx context.Context) error {
	tx.rollbacks++
	_, deadline := ctx.Deadline()
	tx.cleanupOK = deadline && ctx.Err() == nil
	return tx.rollbackErr
}

func TestMutationCompletionAndCleanup(t *testing.T) {
	operationErr := errors.New("operation failure")
	commitErr := errors.New("commit response lost")
	cleanupErr := errors.New("rollback failure")
	for _, tc := range []struct {
		name          string
		operationErr  error
		commitErr     error
		rollbackErr   error
		outcome       store.TransactionOutcome
		phase         string
		cause         error
		commitCount   int
		cleanupFailed bool
	}{
		{name: "commit", rollbackErr: pgx.ErrTxClosed, outcome: store.TransactionCommitted, commitCount: 1},
		{name: "callback rollback", operationErr: operationErr, outcome: store.TransactionNotCommitted, phase: "operation", cause: operationErr},
		{name: "commit rejected", commitErr: pgx.ErrTxCommitRollback, rollbackErr: pgx.ErrTxClosed, outcome: store.TransactionNotCommitted, phase: "commit", cause: pgx.ErrTxCommitRollback, commitCount: 1},
		{name: "unknown commit", commitErr: commitErr, rollbackErr: pgx.ErrTxClosed, outcome: store.TransactionUnknown, phase: "commit", cause: commitErr, commitCount: 1},
		{name: "cleanup failed", operationErr: operationErr, rollbackErr: cleanupErr, outcome: store.TransactionUnknown, phase: "cleanup", cause: operationErr, cleanupFailed: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &completionTx{commitErr: tc.commitErr, rollbackErr: tc.rollbackErr}
			completion, err := transact(context.Background(), tx, func(store.AttachmentMutationScope) error { return tc.operationErr })
			if completion.Outcome != tc.outcome || tx.commits != tc.commitCount || tx.rollbacks != 1 || !tx.cleanupOK {
				t.Fatalf("completion=%#v transaction=%#v error=%v", completion, tx, err)
			}
			if tc.phase == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var failure *store.TransactionError
			if !errors.As(err, &failure) || failure.Phase != tc.phase || failure.Outcome != tc.outcome || failure.CleanupFailed != tc.cleanupFailed || !errors.Is(err, tc.cause) {
				t.Fatalf("failure=%#v error=%v", failure, err)
			}
			if tc.cleanupFailed && !errors.Is(err, cleanupErr) {
				t.Fatalf("cleanup cause missing: %v", err)
			}
		})
	}
}

func TestMutationCancellationUsesIndependentCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tx := &completionTx{}
	completion, err := transact(ctx, tx, func(store.AttachmentMutationScope) error { cancel(); return nil })
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, context.Canceled) || tx.commits != 0 || !tx.cleanupOK {
		t.Fatalf("completion=%#v transaction=%#v error=%v", completion, tx, err)
	}
}
