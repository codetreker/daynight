package worker

import (
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
)

func TestWorkerConfigurationRefusalDoesNotHideTransactionFailure(t *testing.T) {
	refusal := &model.Fault{Code: "version_conflict", Message: "Configuration changed."}
	cleanup := errors.New("rollback failed")
	for _, failure := range []*store.TransactionError{
		{Phase: "cleanup", Cause: errors.Join(refusal, cleanup), Outcome: store.TransactionUnknown, CleanupFailed: true},
		{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
	} {
		err := workerConfigurationError("save worker configuration", failure)
		if err == refusal || !errors.Is(err, failure) {
			t.Fatalf("operational failure replaced with refusal: %v", err)
		}
	}
	failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
	if err := workerConfigurationError("save worker configuration", failure); err != refusal {
		t.Fatalf("rolled back refusal not returned: %v", err)
	}
}
