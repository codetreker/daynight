package completion

import (
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestCapture(t *testing.T) {
	fault := &model.Fault{Code: "forbidden", Message: "Access denied."}
	failure := errors.New("storage failed")
	joined := errors.Join(fault, &store.Error{Phase: "query", DatabaseFailure: true, Cause: failure})
	cleanup := &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: fault}
	threadRollback := &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true, Cause: fault}
	threadUnknown := &store.ThreadTransactionError{Phase: "commit", CommitAttempted: true, OutcomeUnknown: true, Cause: fault}
	for _, tc := range []struct {
		name         string
		operationErr error
		wantErr      error
		wantRefusal  *model.Fault
	}{
		{name: "success"},
		{name: "refusal", operationErr: fault, wantRefusal: fault},
		{name: "wrapped refusal", operationErr: fmt.Errorf("operation: %w", fault), wantRefusal: fault},
		{name: "ordinary error", operationErr: failure, wantErr: failure},
		{name: "database failure with refusal", operationErr: joined, wantErr: joined},
		{name: "cleanup failure with refusal", operationErr: cleanup, wantErr: cleanup},
		{name: "thread rollback failure with refusal", operationErr: threadRollback, wantErr: threadRollback},
		{name: "thread unknown outcome with refusal", operationErr: threadUnknown, wantErr: threadUnknown},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var refusal *model.Fault
			calls := 0
			err := Capture(func() error {
				calls++
				return tc.operationErr
			}, &refusal)
			if calls != 1 || err != tc.wantErr || refusal != tc.wantRefusal {
				t.Fatalf("calls=%d, error=%v, refusal=%v", calls, err, refusal)
			}
		})
	}
}
