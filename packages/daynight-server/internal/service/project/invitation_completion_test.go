package project

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestInvitationWriteErrorPreservesCompletionFailure(t *testing.T) {
	missing := &model.Fault{Code: "not_found", Cause: model.ErrNotFound}
	for _, failure := range []*store.TransactionError{
		{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: missing},
		{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: missing},
	} {
		if got := invitationWriteError(failure); got != failure {
			t.Fatalf("completion failure masked: %v", got)
		}
	}
	err := invitationWriteError(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" {
		t.Fatalf("missing project: %v", err)
	}
}
