package github

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestGrantCompletionClassification(t *testing.T) {
	missing := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
	conflict := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "github_grant_changed", Cause: model.ErrNotFound}}
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		input   error
		want    string
	}{
		{"unknown", store.TransactionUnknown, missing, "github_write_outcome_unknown"},
		{"missing", store.TransactionNotCommitted, missing, "not_found"},
		{"grant conflict", store.TransactionNotCommitted, conflict, "github_grant_changed"},
		{"missing and cleanup failure", store.TransactionNotCommitted, &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, "raw"},
		{"database failure", store.TransactionNotCommitted, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{DatabaseFailure: true, Cause: model.ErrNotFound}}, "raw"},
		{"no receipt", store.TransactionNotCommitted, nil, "raw"},
		{"committed", store.TransactionCommitted, nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := grantCompletion(store.Completion{Outcome: tc.outcome}, tc.input)
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected error")
			}
			if tc.want == "raw" {
				if tc.input != nil && !errors.Is(err, tc.input) {
					t.Fatalf("lost cause: %v", err)
				}
				return
			}
			var f *model.Fault
			var m *ManagementError
			if errors.As(err, &f) && f.Code == tc.want {
				return
			}
			if errors.As(err, &m) && m.Code == tc.want {
				return
			}
			t.Fatalf("unexpected classification: %v", err)
		})
	}
}
