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
func TestDatabaseErrorFactsFindsJoinedFailureAndPreservesCause(t *testing.T) {
	cause := errors.New("driver detail")
	err := errors.Join(&Error{Phase: "read", Cause: errors.New("validation")}, &Error{Phase: "write", DatabaseFailure: true, SQLState: "23505", Cause: cause})
	failed, state := DatabaseErrorFacts(err)
	if !failed || state != "23505" || !errors.Is(err, cause) {
		t.Fatalf("database facts = (%v, %q), cause retained = %v", failed, state, errors.Is(err, cause))
	}
	if failed, state = DatabaseErrorFacts(&Error{Phase: "decode", Cause: errors.New("validation")}); failed || state != "" {
		t.Fatalf("validation classified as database failure: (%v, %q)", failed, state)
	}
}
