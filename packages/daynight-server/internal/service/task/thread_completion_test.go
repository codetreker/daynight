package task

import (
	"context"
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
