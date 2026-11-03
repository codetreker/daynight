package service

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskStepsWriteCompletionRetainsTransactionFactsAndCauses(t *testing.T) {
	cause := errors.New("completion-cause-sentinel")
	cleanup := errors.New("cleanup-cause-sentinel")
	for _, failure := range []*store.TransactionError{
		{Phase: "commit", Cause: cause, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "cleanup", Cause: errors.Join(cause, cleanup), Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true},
		{Phase: "cleanup", Cause: errors.Join(&Fault{Code: "not_found", Message: "business refusal"}, cleanup), Outcome: store.TransactionUnknown, CleanupFailed: true},
	} {
		result, err := finishStepsWrite(StepsWriteResult{Phase: "persist", Changed: true, StepsDocument: StepsDocument{JSON: []byte("unconfirmed bytes")}}, true, failure)
		if !errors.Is(err, failure) || result.TransactionOutcome != failure.Outcome || result.CleanupFailed != failure.CleanupFailed || result.JSON != nil || !result.Changed {
			t.Fatal("write completion replaced causes or completion facts")
		}
		if failure.CommitAttempted && result.Phase != "commit" {
			t.Fatal("attempted Commit lost its phase")
		}
		if _, pure := TaskStepsFault(err); pure {
			t.Fatal("completion failure became a business refusal")
		}
		if errors.Is(failure, cleanup) && !errors.Is(err, cleanup) {
			t.Fatal("cleanup cause was lost")
		}
	}
}
