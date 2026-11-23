package oauth

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type lifecycleCompletionWriter struct {
	*lifecycleFake
	transaction int
	injectAt    int
	outcome     store.TransactionOutcome
	cause       error
}

func (w *lifecycleCompletionWriter) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	w.transaction++
	c, err := w.lifecycleFake.WriteGrantLifecycle(ctx, fn)
	if w.transaction == w.injectAt {
		return store.Completion{Outcome: w.outcome}, errors.Join(err, w.cause)
	}
	return c, err
}

func TestRotationPreservesUnsafeMissingFamilyFailures(t *testing.T) {
	database := &store.Error{Phase: "query", DatabaseFailure: true, SQLState: "08006", Cause: errors.New("connection failed")}
	cleanup := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: errors.New("rollback failed")}
	for _, phase := range []int{1, 2} {
		for _, failure := range []struct {
			name    string
			outcome store.TransactionOutcome
			cause   error
			invalid bool
		}{
			{"clean missing", store.TransactionNotCommitted, nil, true},
			{"database joined with missing", store.TransactionNotCommitted, database, false},
			{"cleanup joined with missing", store.TransactionNotCommitted, cleanup, false},
			{"independent joined cause", store.TransactionNotCommitted, errors.New("unexpected lookup failure"), false},
			{"committed error", store.TransactionCommitted, nil, false},
			{"unknown missing", store.TransactionUnknown, database, false},
		} {
			t.Run(fmt.Sprintf("phase%d/%s", phase, failure.name), func(t *testing.T) {
				fake := newLifecycleFake()
				fake.failures[fmt.Sprintf("refresh:%d", phase)] = model.ErrNotFound
				writer := &lifecycleCompletionWriter{lifecycleFake: fake, injectAt: phase, outcome: failure.outcome, cause: failure.cause}
				result, err := NewGrantLifecycle(writer).Rotate(t.Context(), secret.Random(RefreshPrefix), "client", fake.grant.Resource, func(context.Context, string) error { return nil })
				if result != (RotatedTokens{}) || writer.transaction != phase || !errors.Is(err, model.ErrNotFound) || errors.Is(err, ErrInvalidGrant) != failure.invalid {
					t.Fatalf("result=%+v transactions=%d err=%v", result, writer.transaction, err)
				}
				if failure.cause != nil && !errors.Is(err, failure.cause) {
					t.Fatalf("completion cause lost: %v", err)
				}
				if failure.outcome == store.TransactionUnknown {
					var transaction *store.TransactionError
					if !errors.Is(err, ErrAuthorizationUnknown) || !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown {
						t.Fatalf("unknown completion lost: %v", err)
					}
				}
			})
		}
	}
}

func TestMissingGrantRequiresOnlyCleanLookupCauses(t *testing.T) {
	missing := &store.Error{Phase: "lookup", MissingRow: true, Cause: model.ErrNotFound}
	clean := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: missing}
	for _, test := range []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"wrapped lookup", fmt.Errorf("lookup: %w", clean), true},
		{"joined lookup", errors.Join(model.ErrNotFound, missing), true},
		{"outer storage wrapper", &store.Error{Cause: clean}, true},
		{"database failure", &store.Error{DatabaseFailure: true, Cause: missing}, false},
		{"permission with missing cause", model.Unauthenticated(missing), false},
		{"cleanup failure", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: missing}, false},
		{"commit attempted", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: missing}, false},
		{"committed", &store.TransactionError{Phase: "operation", Outcome: store.TransactionCommitted, Cause: missing}, false},
		{"wrong phase", &store.TransactionError{Phase: "commit", Outcome: store.TransactionNotCommitted, Cause: missing}, false},
		{"independent joined failure", errors.Join(missing, errors.New("other failure")), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := missingGrant(test.err); got != test.want {
				t.Fatalf("missingGrant=%v want=%v err=%v", got, test.want, test.err)
			}
		})
	}
}

func TestRotationCallbackReturnsTypedDomainRefusal(t *testing.T) {
	for _, phase := range []string{"binding", "expiry"} {
		t.Run(phase, func(t *testing.T) {
			fake := newLifecycleFake()
			if phase == "binding" {
				fake.grant.Scope = "other"
			} else {
				fake.grant.ExpiresAt = fake.now
			}
			result, err := NewGrantLifecycle(fake).Rotate(t.Context(), secret.Random(RefreshPrefix), "client", fake.grant.Resource, func(context.Context, string) error { return nil })
			var fault *model.Fault
			if result != (RotatedTokens{}) || !errors.Is(err, ErrInvalidGrant) || !errors.As(err, &fault) || fault.Code != "invalid_grant" {
				t.Fatalf("domain refusal result=%+v err=%v", result, err)
			}
		})
	}
}

func TestLifecycleUnknownPreservesOriginalCompletion(t *testing.T) {
	cause := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CommitAttempted: true, CleanupFailed: true, Cause: errors.Join(context.DeadlineExceeded, ErrInvalidGrant)}
	err := lifecycleCompletion(store.Completion{Outcome: store.TransactionUnknown}, cause)
	var transaction *store.TransactionError
	if !errors.Is(err, ErrAuthorizationUnknown) || !errors.Is(err, cause) || !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &transaction) || transaction != cause || !transaction.CleanupFailed {
		t.Fatalf("unknown cause lost: %v", err)
	}
}
