package task

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskWriteRedactionPreservesTransactionFacts(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:status"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	ctx := WithTaskWriteAuthorization(t.Context(), model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, false)
	fault := &model.Fault{Code: "dependency_unsatisfied", Message: "not ready", TaskIDs: []string{"private-task"}}
	safe := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: fault}
	got := redactTaskWriteError(ctx, safe)
	var transaction *store.TransactionError
	var visible *model.Fault
	if !errors.As(got, &transaction) || transaction != safe || !errors.As(got, &visible) || visible.Code != fault.Code || len(visible.TaskIDs) != 0 {
		t.Fatalf("lost transaction facts or leaked IDs: %#v", got)
	}
	for _, unsafe := range []error{
		&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: fault},
		&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: fault},
		errors.Join(safe, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown}),
	} {
		if redactTaskWriteError(ctx, unsafe) != unsafe {
			t.Fatalf("changed unsafe transaction: %#v", unsafe)
		}
	}
}
