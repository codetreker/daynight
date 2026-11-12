package workerreadonly

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestReceivedOutcomeKeepsAuthorityFailureAfterCallerEnds(t *testing.T) {
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	expired, stop := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	defer stop()
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.DeadlineExceeded}
	cleanup := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: context.Canceled}
	database := &store.Error{Phase: "access recheck", DatabaseFailure: true, SQLState: "08006", Cause: context.Canceled}
	for _, tc := range []struct {
		name string
		ctx  context.Context
		err  error
	}{
		{"unknown deadline", expired, unknown},
		{"cleanup cancellation", cancelled, errors.Join(model.Unauthenticated(model.ErrNotFound), cleanup)},
		{"database cancellation", cancelled, errors.Join(&store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted}, database)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			broker := New(func(context.Context, model.Principal, string) error {
				t.Fatal("failed outcome rechecked authority")
				return nil
			})
			defer broker.Close()
			message, err := broker.receiveOutcome(tc.ctx, model.Principal{}, "", nil, outcome{err: tc.err})
			if err != tc.err || len(message.Result) != 0 || requestContextError(tc.ctx, err) != tc.err {
				t.Fatalf("received failure replaced after caller ended: %+v %v", message, err)
			}
		})
	}
	t.Run("successful outcome after cancellation", func(t *testing.T) {
		broker := New(func(context.Context, model.Principal, string) error {
			t.Fatal("cancelled result rechecked authority")
			return nil
		})
		defer broker.Close()
		message, err := broker.receiveOutcome(cancelled, model.Principal{}, "", nil, outcome{message: Message{Type: "result"}})
		if !errors.Is(err, context.Canceled) || message.Type != "" {
			t.Fatalf("successful outcome returned after caller cancellation: %+v %v", message, err)
		}
	})
}
