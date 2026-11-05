package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type failedTaskWriter struct {
	store.SnapshotReader
	failure error
}

func (s failedTaskWriter) WriteProject(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionUnknown}, s.failure
}

func TestWriteTaskPreservesCleanupFailureOverMissingProject(t *testing.T) {
	cleanup := errors.New("cleanup failed")
	failure := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.Join(model.ErrNotFound, cleanup)}
	tasks := NewTasks(failedTaskWriter{failure: failure})
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333", Kind: model.PATCredential}
	_, err := tasks.Create(context.Background(), principal, "22222222-2222-4222-8222-222222222222", taskcore.CreateTask{Title: "Task"})
	var got *store.TransactionError
	if !errors.As(err, &got) || got != failure || !errors.Is(err, cleanup) {
		t.Fatalf("lost transaction failure: %v", err)
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		t.Fatalf("cleanup failure became domain refusal: %v", err)
	}
}

func TestWriteTaskMapsConfirmedMissingProject(t *testing.T) {
	failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
	tasks := NewTasks(failedTaskWriter{failure: failure})
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333", Kind: model.PATCredential}
	_, err := tasks.Create(context.Background(), principal, "22222222-2222-4222-8222-222222222222", taskcore.CreateTask{Title: "Task"})
	fault, ok := err.(*model.Fault)
	if !ok || fault.Code != "not_found" {
		t.Fatalf("missing project error: %v", err)
	}
}
