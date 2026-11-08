package project

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProjectWriteErrorPreservesCompletionEvidence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure *store.TransactionError
		mapped  bool
	}{
		{"confirmed rollback", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}, true},
		{"unknown commit", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: model.ErrNotFound}, false},
		{"cleanup failure", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: model.ErrNotFound}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ProjectWriteError(tc.failure)
			var fault *model.Fault
			if errors.As(err, &fault) != tc.mapped {
				t.Fatalf("mapped=%v, error=%v", tc.mapped, err)
			}
			if !tc.mapped && err != tc.failure {
				t.Fatalf("lost transaction failure: %v", err)
			}
		})
	}
}

func TestProjectWriteErrorPreservesDomainFault(t *testing.T) {
	fault := &model.Fault{Code: "not_found", Message: "Project member was not found.", Cause: model.ErrNotFound}
	if got := ProjectWriteError(fault); got != fault {
		t.Fatalf("domain fault replaced: %v", got)
	}
}
