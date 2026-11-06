package bot

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDeletionResultPreservesCommitKnowledge(t *testing.T) {
	if deletionResultError(nil) != nil {
		t.Fatal("nil became an error")
	}
	notFound := &store.TransactionError{Phase: "operation", Cause: model.ErrNotFound, Outcome: store.TransactionNotCommitted}
	var fault *model.Fault
	if err := deletionResultError(notFound); !errors.As(err, &fault) || fault.Code != "not_found" {
		t.Fatalf("missing session: %v", err)
	}
	unknown := &store.TransactionError{Phase: "commit", Cause: model.ErrNotFound, Outcome: store.TransactionUnknown, CommitAttempted: true}
	if err := deletionResultError(unknown); err != unknown {
		t.Fatalf("unknown commit was masked: %v", err)
	}
}
