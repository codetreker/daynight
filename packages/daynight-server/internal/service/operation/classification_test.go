package operation_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestCompletionFactsPreservesTransactionAndCleanup(t *testing.T) {
	refusal := &model.Fault{Code: "invalid_input", Message: "invalid"}
	cases := []struct {
		name string
		err  error
		want operation.Facts
	}{
		{"ordinary refusal", refusal, operation.Facts{}},
		{"cancellation", context.Canceled, operation.Facts{}},
		{"known rollback", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: refusal}, operation.Facts{Outcome: store.TransactionNotCommitted, Phase: "operation"}},
		{"commit lost", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}, operation.Facts{Outcome: store.TransactionUnknown, Phase: "commit"}},
		{"committed cleanup failure", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true}, operation.Facts{Outcome: store.TransactionCommitted, Phase: "cleanup", CleanupFailed: true}},
		{"thread unknown", &store.ThreadTransactionError{Phase: "commit", CommitAttempted: true, OutcomeUnknown: true}, operation.Facts{Outcome: store.TransactionUnknown, Phase: "commit"}},
		{"thread cleanup", &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true}, operation.Facts{Phase: "rollback", CleanupFailed: true}},
		{"thread rolled back", &taskservice.ThreadMessageError{Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "callback", Cause: refusal}}, operation.Facts{Outcome: store.TransactionNotCommitted, Phase: "callback"}},
		{"thread committed cleanup failure", &taskservice.ThreadMessageError{Outcome: store.TransactionCommitted, Cause: &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true}}, operation.Facts{Outcome: store.TransactionCommitted, Phase: "rollback", CleanupFailed: true}},
		{"thread contradictory completion", &taskservice.ThreadMessageError{Outcome: store.TransactionNotCommitted, Cause: &store.ThreadTransactionError{Phase: "commit", OutcomeUnknown: true}}, operation.Facts{Outcome: store.TransactionUnknown, Phase: "commit"}},
		{"conflicting facts", errors.Join(&store.TransactionError{Outcome: store.TransactionCommitted}, &store.TransactionError{Outcome: store.TransactionNotCommitted}), operation.Facts{Outcome: store.TransactionUnknown}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := operation.CompletionFacts(fmt.Errorf("operation: %w", tc.err)); got != tc.want {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestKnownFaultDoesNotExposeFailedCompletion(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	if got, ok := operation.KnownFault(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}); !ok || got != fault {
		t.Fatalf("known rollback: %v %v", got, ok)
	}
	for _, failure := range []*store.TransactionError{
		{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault},
		{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: fault},
	} {
		if got, ok := operation.KnownFault(failure); ok {
			t.Fatalf("exposed nested fault %#v", got)
		}
	}
}

func TestKnownTransferAndMediaFaultsRequireConfirmedRollback(t *testing.T) {
	for _, code := range []string{"transfer_conflict", "transfer_state_conflict", "capacity_unavailable", "invalid_image", "image_integrity", "image_decode_failed", "component_unsupported", "quota_exceeded", "resource_in_use", "capability_changed", "media_outcome_unknown", "archive_conflict", "archive_incomplete"} {
		fault := &model.Fault{Code: code, Message: "refused"}
		if got, ok := operation.KnownFault(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}); !ok || got.Code != code {
			t.Fatalf("confirmed refusal %s was suppressed", code)
		}
		if _, ok := operation.KnownFault(&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault}); ok {
			t.Fatalf("unknown result exposed as %s", code)
		}
	}
}

func TestKnownFaultRejectsUnsafeJoinedTransaction(t *testing.T) {
	fault := &model.Fault{Code: "invalid_input", Message: "invalid"}
	failure := errors.Join(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true})
	if _, ok := operation.KnownFault(failure); ok {
		t.Fatal("unsafe joined result exposed as refusal")
	}
	facts := operation.CompletionFacts(failure)
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
		if got, ok := operation.KnownFault(err); ok {
			t.Fatalf("database failure exposed as business rejection: %#v", got)
		}
	}
	if got, ok := operation.KnownFault(fault); !ok || got.Code != "invalid_search_expression" {
		t.Fatalf("valid search refusal lost: %#v %v", got, ok)
	}
}

func TestNativeSelectionFaultsRequireReliableCompletion(t *testing.T) {
	for _, code := range []string{"unsupported_native_selection", "unsupported_selection", "unknown_default", "stale_configuration", "capability_error", "cleanup_unknown", "io_error", "offline", "unsupported", "timeout", "cancelled", "busy", "limit_exceeded", "invalid_cursor", "invalid_path"} {
		t.Run(code, func(t *testing.T) {
			fault := &model.Fault{Code: code, Message: "Native selection refused"}
			for _, safe := range []error{fault, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}} {
				if got, ok := operation.KnownFault(safe); !ok || got != fault {
					t.Fatalf("confirmed native refusal was suppressed: %#v %v", got, ok)
				}
			}
			for _, unsafe := range []error{
				&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault},
				&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: fault},
				errors.Join(fault, &store.Error{DatabaseFailure: true, Cause: errors.New("database failure")}),
				&model.BotOperationError{Operation: "create", Cause: fault},
			} {
				if got, ok := operation.KnownFault(unsafe); ok {
					t.Fatalf("uncertain operation exposed native fault: %#v", got)
				}
			}
		})
	}
	if _, ok := operation.KnownFault(&model.Fault{Code: "unregistered_native_error", Message: "private"}); ok {
		t.Fatal("unregistered faults became public")
	}
}

func TestTagFaultsRequireReliableCompletion(t *testing.T) {
	for _, code := range []string{"invalid_tag_name", "invalid_tag_filter", "confirmation_required", "tag_not_found", "catalog_changed", "tag_name_conflict"} {
		fault := &model.Fault{Code: code, Message: "refused"}
		if got, ok := operation.KnownFault(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}); !ok || got != fault {
			t.Fatalf("confirmed refusal %s was suppressed", code)
		}
		if _, ok := operation.KnownFault(&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: fault}); ok {
			t.Fatalf("unknown result exposed as %s", code)
		}
	}
}
