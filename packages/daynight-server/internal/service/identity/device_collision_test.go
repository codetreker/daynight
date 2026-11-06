package identity

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDeviceCollisionRequiresKnownRollback(t *testing.T) {
	driver := errors.New("driver detail")
	collision := &store.Error{Phase: "insert", DatabaseFailure: true, SQLState: "23505", Cause: driver}
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"rolled back collision", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: collision}, true},
		{"unknown outcome", &store.TransactionError{Phase: "operation", Outcome: store.TransactionUnknown, Cause: collision}, false},
		{"cleanup failed", &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: collision}, false},
		{"commit failed", &store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted, Cause: collision}, false},
		{"other database failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{DatabaseFailure: true, SQLState: "08006", Cause: driver}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := deviceCollision(tc.err); got != tc.want || !errors.Is(tc.err, driver) {
				t.Fatalf("collision=%v, cause retained=%v", got, errors.Is(tc.err, driver))
			}
		})
	}
}
