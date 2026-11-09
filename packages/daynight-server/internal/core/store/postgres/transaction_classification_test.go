package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type classificationTx struct {
	pgx.Tx
	commit, rollback error
}

func (tx classificationTx) Commit(context.Context) error   { return tx.commit }
func (tx classificationTx) Rollback(context.Context) error { return tx.rollback }

func TestTransactionFailureClassification(t *testing.T) {
	fault := &model.Fault{Code: "not_found", Message: "not found"}
	driver := &pgconn.PgError{Code: "23505", Message: "private"}
	cleanup := errors.New("cleanup")
	for _, tc := range []struct {
		name      string
		tx        classificationTx
		operation error
		failure   bool
		state     string
		outcome   store.TransactionOutcome
	}{
		{"domain refusal", classificationTx{}, fault, false, "", store.TransactionNotCommitted},
		{"driver and refusal", classificationTx{}, errors.Join(fault, driver), true, "23505", store.TransactionNotCommitted},
		{"failed cleanup", classificationTx{rollback: cleanup}, fault, true, "", store.TransactionUnknown},
		{"unknown commit", classificationTx{commit: driver, rollback: pgx.ErrTxClosed}, nil, true, "23505", store.TransactionUnknown},
		{"committed with cleanup failure", classificationTx{rollback: cleanup}, nil, true, "", store.TransactionCommitted},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := transact(context.Background(), tc.tx, func(pgx.Tx) error { return tc.operation })
			failed, state := store.DatabaseErrorFacts(err)
			var transaction *store.TransactionError
			if failed != tc.failure || state != tc.state || !errors.As(err, &transaction) || transaction.Outcome != tc.outcome {
				t.Fatalf("facts=(%v,%q), transaction=%+v, error=%v", failed, state, transaction, err)
			}
			if tc.operation != nil && !errors.Is(err, tc.operation) || tc.tx.commit != nil && !errors.Is(err, tc.tx.commit) || tc.tx.rollback == cleanup && !errors.Is(err, cleanup) {
				t.Fatalf("transaction lost cause: %v", err)
			}
		})
	}
}

func TestThreadCompletionFailuresPreserveFaultAndCause(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	cleanup := errors.New("cleanup")
	completion, err := writeThread(context.Background(), classificationTx{rollback: cleanup}, func(store.ThreadScope) error { return fault })
	var stage *store.ThreadTransactionError
	failed, _ := store.DatabaseErrorFacts(err)
	if !errors.As(err, &stage) || !stage.RollbackFailed || completion.Outcome != store.TransactionUnknown || !failed || !errors.Is(err, fault) || !errors.Is(err, cleanup) {
		t.Fatalf("rollback: completion=%+v stage=%+v err=%v", completion, stage, err)
	}
	commit := &pgconn.PgError{Code: "08006", Message: "private"}
	completion, err = writeThread(context.Background(), classificationTx{commit: commit, rollback: pgx.ErrTxClosed}, func(store.ThreadScope) error { return nil })
	failed, state := store.DatabaseErrorFacts(err)
	if !errors.As(err, &stage) || !stage.OutcomeUnknown || completion.Outcome != store.TransactionUnknown || !failed || state != "08006" || !errors.Is(err, commit) {
		t.Fatalf("commit: completion=%+v stage=%+v state=%q err=%v", completion, stage, state, err)
	}
}
