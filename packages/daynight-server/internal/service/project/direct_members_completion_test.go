package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type directCompletionWriter struct {
	outcome store.Completion
	err     error
}

func (w directCompletionWriter) WriteProjectDirectMember(context.Context, string, func(store.ProjectDirectMemberScope) error) (store.Completion, error) {
	return w.outcome, w.err
}
func TestDirectMemberCompletionDoesNotExposeAResult(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, CredentialID: "10000000-0000-4000-8000-000000000003", UserID: "10000000-0000-4000-8000-000000000001"}
	cause := errors.New("lost confirmation")
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
	cleanup := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("cleanup")}
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		err     error
	}{
		{"unknown", store.TransactionUnknown, unknown}, {"unknown and cleanup", store.TransactionUnknown, errors.Join(unknown, cleanup)}, {"unknown no error", store.TransactionUnknown, nil}, {"not committed", store.TransactionNotCommitted, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := NewDirectMembers(directCompletionWriter{store.Completion{Outcome: tc.outcome}, tc.err}, "https://example.test/api/v1")
			got, err := s.AddExistingMember(t.Context(), p, "10000000-0000-4000-8000-000000000004", "10000000-0000-4000-8000-000000000002", p.UserID)
			if err == nil || !reflect.DeepEqual(got, core.ExistingMemberResult{}) {
				t.Fatalf("result %+v err %v", got, err)
			}
			if tc.err != nil && !errors.Is(err, tc.err) {
				t.Fatalf("lost error chain: %v", err)
			}
			if tc.name == "unknown no error" {
				var tx *store.TransactionError
				if !errors.As(err, &tx) || !tx.CommitAttempted || tx.Outcome != store.TransactionUnknown {
					t.Fatalf("unknown without marker: %v", err)
				}
			}
		})
	}
}
