package store

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestStoreErrorDiagnosticsDoNotExposeDriverCauses(t *testing.T) {
	cause := errors.New("driver detail: SELECT private_value FROM private_table")
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{"database", &Error{Phase: "query", SQLState: "23505", DatabaseFailure: true, Cause: cause}, "database query failed"},
		{"transaction", &TransactionError{Phase: "commit", Cause: cause, Outcome: TransactionUnknown, CommitAttempted: true}, "transaction commit failed"},
		{"thread transaction", &ThreadTransactionError{Phase: "rollback", Cause: cause, RollbackFailed: true}, "thread transaction rollback failed"},
		{"clock", &ThreadClockError{Cause: cause}, "reliable forward clock position was not obtained within budget"},
		{"maintenance", &AttachmentMaintenanceError{Stage: AttachmentMaintenanceMetadataQuery, Cause: cause}, "attachment maintenance: metadata_query"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := test.err.Error(); got != test.want {
				t.Fatalf("Error() = %q; want %q", got, test.want)
			}
			if !errors.Is(test.err, cause) {
				t.Fatal("diagnostic error lost the original driver cause")
			}
		})
	}
}

func TestDatabaseErrorFacts(t *testing.T) {
	ordinary := errors.New("operation failed")
	withoutState := &Error{Phase: "connect", DatabaseFailure: true, Cause: ordinary}
	withState := &Error{Phase: "query", DatabaseFailure: true, SQLState: "40001", Cause: ordinary}
	for _, test := range []struct {
		name  string
		err   error
		want  bool
		state string
	}{
		{name: "nil"},
		{name: "ordinary", err: ordinary},
		{name: "non database error with a SQL state", err: &Error{SQLState: "23505", Cause: ordinary}},
		{name: "database without SQL state", err: withoutState, want: true},
		{name: "database with SQL state", err: withState, want: true, state: "40001"},
		{name: "wrapped database error", err: fmt.Errorf("operation: %w", withState), want: true, state: "40001"},
		{name: "wrapped ordinary error", err: fmt.Errorf("operation: %w", ordinary)},
		{name: "joined ordinary errors", err: errors.Join(ordinary, errors.New("cleanup failed"))},
		{name: "joined database without SQL state", err: errors.Join(ordinary, withoutState), want: true},
		{name: "joined database after ordinary cause", err: errors.Join(ordinary, withState), want: true, state: "40001"},
		{name: "joined database after stateless database", err: errors.Join(withoutState, withState), want: true, state: "40001"},
		{name: "first database state wins", err: errors.Join(withState, &Error{DatabaseFailure: true, SQLState: "23505"}), want: true, state: "40001"},
		{name: "outer SQL state wins", err: &Error{DatabaseFailure: true, SQLState: "08006", Cause: withState}, want: true, state: "08006"},
		{name: "stateless database wrapping joined causes", err: &Error{DatabaseFailure: true, Cause: errors.Join(ordinary, ordinary)}, want: true},
		{name: "stateless database wrapping stateful cause", err: &Error{DatabaseFailure: true, Cause: withState}, want: true, state: "40001"},
		{name: "nested cleanup chain", err: &TransactionError{Phase: "cleanup", Cause: errors.Join(ordinary, fmt.Errorf("rollback: %w", withState))}, want: true, state: "40001"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, state := DatabaseErrorFacts(test.err)
			if got != test.want || state != test.state {
				t.Fatalf("DatabaseErrorFacts() = %v, %q; want %v, %q", got, state, test.want, test.state)
			}
		})
	}
}

func TestTransactionErrorsRetainOutcomeFactsThroughWrapping(t *testing.T) {
	cause := errors.New("connection closed after COMMIT")
	transaction := &TransactionError{
		Phase: "commit", Cause: cause, Outcome: TransactionUnknown,
		CommitAttempted: true, CleanupFailed: true,
	}
	var found *TransactionError
	if !errors.As(fmt.Errorf("update: %w", transaction), &found) || found != transaction {
		t.Fatal("wrapped transaction error lost its typed completion facts")
	}
	if found.Outcome != TransactionUnknown || !found.CommitAttempted || !found.CleanupFailed || !errors.Is(found, cause) {
		t.Fatalf("transaction facts = %#v", found)
	}
	thread := &ThreadTransactionError{
		Phase: "commit", Cause: cause, CommitAttempted: true,
		OutcomeUnknown: true, RollbackFailed: true,
	}
	var foundThread *ThreadTransactionError
	if !errors.As(fmt.Errorf("submit: %w", thread), &foundThread) || foundThread != thread {
		t.Fatal("wrapped thread error lost its typed completion facts")
	}
	if !foundThread.CommitAttempted || !foundThread.OutcomeUnknown || !foundThread.RollbackFailed || !errors.Is(foundThread, cause) {
		t.Fatalf("thread facts = %#v", foundThread)
	}
}

func TestClockAndMaintenanceErrorsRetainTypedFacts(t *testing.T) {
	cause := errors.New("read failed")
	now := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
	clock := &ThreadClockError{Head: model.ThreadPosition{CreatedAt: now}, Observed: now.Add(-time.Second), Cause: cause}
	var foundClock *ThreadClockError
	if !errors.As(fmt.Errorf("prepare: %w", clock), &foundClock) || foundClock != clock {
		t.Fatal("wrapped clock error lost its typed timing facts")
	}
	if foundClock.Head != clock.Head || !foundClock.Observed.Equal(clock.Observed) || !errors.Is(foundClock, cause) {
		t.Fatalf("clock facts = %#v", foundClock)
	}
	maintenance := &AttachmentMaintenanceError{Stage: AttachmentMaintenanceProjectsDecode, Cause: cause}
	var foundMaintenance *AttachmentMaintenanceError
	if !errors.As(fmt.Errorf("inventory: %w", maintenance), &foundMaintenance) || foundMaintenance != maintenance {
		t.Fatal("wrapped maintenance error lost its typed stage")
	}
	if foundMaintenance.Stage != AttachmentMaintenanceProjectsDecode || !errors.Is(foundMaintenance, cause) {
		t.Fatalf("maintenance facts = %#v", foundMaintenance)
	}
}
