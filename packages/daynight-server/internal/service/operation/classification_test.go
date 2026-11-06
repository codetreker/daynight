package operation

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestCompletionFactsPreservesTransactionAndCleanup(t *testing.T) {
	refusal := &model.Fault{Code: "invalid_input", Message: "invalid"}
	cases := []struct {
		name string
		err  error
		want Facts
	}{
		{"ordinary refusal", refusal, Facts{}},
		{"cancellation", context.Canceled, Facts{}},
		{"known rollback", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: refusal}, Facts{Outcome: store.TransactionNotCommitted, Phase: "operation"}},
		{"commit lost", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}, Facts{Outcome: store.TransactionUnknown, Phase: "commit"}},
		{"committed cleanup failure", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true}, Facts{Outcome: store.TransactionCommitted, Phase: "cleanup", CleanupFailed: true}},
		{"thread unknown", &store.ThreadTransactionError{Phase: "commit", CommitAttempted: true, OutcomeUnknown: true}, Facts{Outcome: store.TransactionUnknown, Phase: "commit"}},
		{"thread cleanup", &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true}, Facts{Phase: "rollback", CleanupFailed: true}},
		{"thread rolled back", &taskservice.ThreadMessageError{Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "callback", Cause: refusal}}, Facts{Outcome: store.TransactionNotCommitted, Phase: "callback"}},
		{"thread committed cleanup failure", &taskservice.ThreadMessageError{Outcome: store.TransactionCommitted, Cause: &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true}}, Facts{Outcome: store.TransactionCommitted, Phase: "rollback", CleanupFailed: true}},
		{"thread contradictory completion", &taskservice.ThreadMessageError{Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "commit", OutcomeUnknown: true}}, Facts{Outcome: store.TransactionUnknown, Phase: "commit"}},
		{"conflicting facts", errors.Join(&store.TransactionError{Outcome: store.TransactionCommitted}, &store.TransactionError{Outcome: store.TransactionNotCommitted}), Facts{Outcome: store.TransactionUnknown}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CompletionFacts(fmt.Errorf("operation: %w", tc.err)); got != tc.want {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestKnownFaultDoesNotExposeFailedCompletion(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	if got, ok := KnownFault(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}); !ok || got != fault {
		t.Fatalf("known rollback: %v %v", got, ok)
	}
	for _, failure := range []*store.TransactionError{
		{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault},
		{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: fault},
	} {
		if got, ok := KnownFault(failure); ok {
			t.Fatalf("exposed nested fault %#v", got)
		}
	}
}

func TestKnownTransferRefusalsRequireConfirmedRollback(t *testing.T) {
	for _, code := range []string{"transfer_conflict", "transfer_state_conflict", "capacity_unavailable"} {
		fault := &model.Fault{Code: code, Message: "refused"}
		if got, ok := KnownFault(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}); !ok || got.Code != code {
			t.Fatalf("confirmed refusal %s was suppressed", code)
		}
		if _, ok := KnownFault(&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault}); ok {
			t.Fatalf("unknown result exposed as %s", code)
		}
	}
}

func TestKnownFaultRejectsUnsafeJoinedTransaction(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	failure := errors.Join(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true})
	if _, ok := KnownFault(failure); ok {
		t.Fatal("unsafe joined result exposed as refusal")
	}
	facts := CompletionFacts(failure)
	if facts.Outcome != store.TransactionUnknown || !facts.CleanupFailed {
		t.Fatalf("lost completion facts: %#v", facts)
	}
}

func TestKnownFaultSuppressesJoinedDatabaseFailure(t *testing.T) {
	fault := &model.Fault{Code: "invalid_search_expression", Message: "invalid search"}
	database := &store.Error{Phase: "query", SQLState: "XX000", DatabaseFailure: true, Cause: errors.New("private database details")}
	for _, err := range []error{
		errors.Join(fault, database),
		&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: errors.Join(fault, database)},
	} {
		if got, ok := KnownFault(err); ok {
			t.Fatalf("database failure exposed as business rejection: %#v", got)
		}
	}
	if got, ok := KnownFault(fault); !ok || got.Code != "invalid_search_expression" {
		t.Fatalf("valid search refusal lost: %#v %v", got, ok)
	}
}
