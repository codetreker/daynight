package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type archiveCompletionOrderWriter func(context.Context, func(store.SessionScope) error) (store.Completion, error)

func (w archiveCompletionOrderWriter) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	return w(ctx, work)
}

type archiveCompletionOrderScope struct{ store.SessionScope }

func TestSessionWriteFinishesAfterTransactionReturns(t *testing.T) {
	ctx := t.Context()
	scope := &archiveCompletionOrderScope{}
	cause := errors.New("transaction cleanup failed")
	completionError := &store.TransactionError{Phase: "cleanup", Cause: cause, Outcome: store.TransactionCommitted, CommitAttempted: true, CleanupFailed: true}
	var calls []string
	active, callbackReturned, completionReturned := false, false, false
	service := &Service{writer: archiveCompletionOrderWriter(func(actual context.Context, work func(store.SessionScope) error) (store.Completion, error) {
		if actual != ctx || len(calls) != 0 || active {
			t.Fatal("unexpected transaction writer call")
		}
		active = true
		calls = append(calls, "writer")
		defer func() { active = false; completionReturned = true; calls = append(calls, "completion returned") }()
		if err := work(scope); err != nil {
			t.Fatalf("mock business operation failed: %v", err)
		}
		callbackReturned = true
		calls = append(calls, "callback returned")
		return store.Completion{Outcome: store.TransactionCommitted}, completionError
	})}
	finish := func(outcome store.TransactionOutcome) {
		if active || !callbackReturned || !completionReturned || len(calls) != 4 || outcome != store.TransactionCommitted {
			t.Fatalf("Finish(%s) before callback and completion returned: %v", outcome, calls)
		}
		calls = append(calls, "finish")
	}
	err := service.write(ctx, finish, func(actual store.SessionScope) error {
		if actual != scope || !active || callbackReturned || completionReturned || len(calls) != 1 {
			t.Fatal("unexpected lower business callback")
		}
		calls = append(calls, "business operation")
		return nil
	})
	if err != completionError || !errors.Is(err, cause) {
		t.Fatalf("completion error lost identity or cause: %v", err)
	}
	want := []string{"writer", "business operation", "callback returned", "completion returned", "finish"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("completion order %v want %v", calls, want)
	}
}
