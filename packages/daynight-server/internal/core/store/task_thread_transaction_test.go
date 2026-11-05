package store

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

type threadCommitResponseLoss struct {
	pgx.Tx
	cause error
}

func (tx *threadCommitResponseLoss) Commit(ctx context.Context) error {
	if err := tx.Tx.Commit(ctx); err != nil {
		return err
	}
	return tx.cause
}

func TestThreadCommitAppliedWithLostResponseRemainsUnknown(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cause := errors.New("commit response lost")
	err = writeThread(ctx, &threadCommitResponseLoss{Tx: tx, cause: cause}, func(tx *ThreadTx) error {
		_, err := tx.InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "committed once"})
		return err
	})
	var failure *ThreadTransactionError
	if !errors.As(err, &failure) || !failure.CommitAttempted || !failure.OutcomeUnknown || failure.RollbackFailed || !errors.Is(err, cause) || failure.Phase != "commit" {
		t.Fatalf("unknown commit classification: %#v %v", failure, err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM task_thread_messages`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("real commit not observed: %d %v", count, err)
	}
	if failure.Error() != "thread transaction commit failed" {
		t.Fatal("transaction diagnostic exposed upstream cause")
	}
}

func TestThreadAbortedCommitIsConfirmedRollback(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	err := database.WriteThread(ctx, func(tx *ThreadTx) error {
		_, _ = tx.tx.Exec(ctx, "SELECT 1/0")
		return nil
	})
	var failure *ThreadTransactionError
	if !errors.As(err, &failure) || !failure.CommitAttempted || failure.OutcomeUnknown || !errors.Is(err, pgx.ErrTxCommitRollback) {
		t.Fatalf("confirmed commit rejection: %#v %v", failure, err)
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestThreadRollbackKeepsCancellationAndCleanupCause(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cleanup := errors.New("cleanup failed")
	wrapped := &rollbackFailureTx{Tx: tx, failure: cleanup}
	err = writeThread(ctx, wrapped, func(tx *ThreadTx) error {
		_, err := tx.InsertMessage(ctx, model.ThreadMessage{TaskID: queryID(1), Author: model.ThreadAuthor{UserID: queryID(9)}, Body: "canceled"})
		if err != nil {
			return err
		}
		cancel()
		return context.Canceled
	})
	var failure *ThreadTransactionError
	if !errors.As(err, &failure) || !failure.RollbackFailed || failure.CommitAttempted || !errors.Is(err, context.Canceled) || !errors.Is(err, cleanup) || !wrapped.bounded {
		t.Fatalf("rollback failure chain: %#v %v bounded=%v", failure, err, wrapped.bounded)
	}
	assertMigrationPoolReusable(t, database.Pool)
	var count int
	if err := database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM task_thread_messages`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("canceled message committed: %d %v", count, err)
	}
}

func TestThreadCancellationBeforeCommitAndPanicCleanup(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	err := database.WriteThread(ctx, func(tx *ThreadTx) error { cancel(); return nil })
	var failure *ThreadTransactionError
	if !errors.As(err, &failure) || failure.CommitAttempted || !errors.Is(err, context.Canceled) {
		t.Fatalf("precommit cancellation: %#v %v", failure, err)
	}
	func() {
		defer func() {
			if recover() != "thread panic" {
				t.Fatal("panic not propagated")
			}
		}()
		_ = database.WriteThread(context.Background(), func(*ThreadTx) error { panic("thread panic") })
	}()
	assertMigrationPoolReusable(t, database.Pool)
	err = database.WriteThread(ctx, func(*ThreadTx) error { t.Fatal("callback reached canceled begin"); return nil })
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled begin cause lost: %v", err)
	}
}
