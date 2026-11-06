package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type uncertainThreadWriter struct{}

func (uncertainThreadWriter) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("unexpected read")
}
func (uncertainThreadWriter) WriteThread(context.Context, func(store.ThreadScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionUnknown}, nil
}

func TestThreadUnknownCompletionCannotReturnSuccess(t *testing.T) {
	threads := NewTaskThreads(uncertainThreadWriter{})
	principal := model.Principal{Kind: model.PATCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	result, err := threads.Post(context.Background(), principal, "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", CreateThreadMessage{Body: "test"})
	fault, ok := ThreadResponseFault(err)
	if !ok || fault.Code != "message_outcome_unknown" || result.JSON != nil {
		t.Fatalf("unknown completion returned success: %#v %v", result, err)
	}
}

type failedThreadWriter struct {
	completion store.Completion
	err        error
}

func (failedThreadWriter) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("unexpected read")
}
func (w failedThreadWriter) WriteThread(context.Context, func(store.ThreadScope) error) (store.Completion, error) {
	return w.completion, w.err
}

func TestThreadPostRetainsActualCompletionOnFailure(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown, store.TransactionCommitted} {
		t.Run(string(outcome), func(t *testing.T) {
			cause := &store.ThreadTransactionError{Phase: "rollback", RollbackFailed: true}
			threads := NewTaskThreads(failedThreadWriter{completion: store.Completion{Outcome: outcome}, err: cause})
			_, err := threads.Post(context.Background(), principal, "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", CreateThreadMessage{Body: "test"})
			var failure *ThreadMessageError
			var completion interface {
				TransactionOutcome() store.TransactionOutcome
			}
			if !errors.As(err, &failure) || failure.Outcome != outcome || !errors.As(err, &completion) || completion.TransactionOutcome() != outcome || !errors.Is(err, cause) {
				t.Fatalf("lost completion or cause: %#v %v", failure, err)
			}
		})
	}
}
