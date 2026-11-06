package service

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	var transaction *store.TransactionError
	wrapped := errors.As(err, &transaction) && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || (!wrapped && err.Error() != fault.Message) {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

type entropyFailure struct{ err error }

func (r entropyFailure) Read([]byte) (int, error) { return 0, r.err }
