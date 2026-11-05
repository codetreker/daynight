package store

import (
	"errors"
	"testing"
)

func TestCompletionOutcomes(t *testing.T) {
	for _, test := range []struct {
		outcome TransactionOutcome
		want    string
	}{
		{TransactionCommitted, "committed"},
		{TransactionNotCommitted, "not_committed"},
		{TransactionUnknown, "unknown"},
	} {
		completion := Completion{Outcome: test.outcome}
		if string(completion.Outcome) != test.want {
			t.Errorf("outcome = %q, want %q", completion.Outcome, test.want)
		}
	}
	if (Completion{}).Outcome == TransactionNotCommitted {
		t.Fatal("an absent outcome must not assert rollback")
	}
}

func TestCompletionErrorsPreserveCauses(t *testing.T) {
	operation, cleanup := errors.New("operation"), errors.New("cleanup")
	joined := errors.Join(operation, cleanup)
	errorsToCheck := []error{
		&Error{Phase: "query", Cause: joined},
		&TransactionError{Phase: "cleanup", Cause: joined, Outcome: TransactionUnknown, CleanupFailed: true},
		&ThreadTransactionError{Phase: "rollback", Cause: joined, RollbackFailed: true},
		&ThreadClockError{Cause: joined},
	}
	for _, err := range errorsToCheck {
		if !errors.Is(err, operation) || !errors.Is(err, cleanup) {
			t.Errorf("%T lost a cause: %v", err, err)
		}
	}
}
