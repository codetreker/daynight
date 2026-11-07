package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
)

type attachmentCompletionWriter struct {
	inner   store.AttachmentMutationWriter
	outcome store.TransactionOutcome
}

func (w attachmentCompletionWriter) WriteAttachmentMutation(ctx context.Context, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
	completion, err := w.inner.WriteAttachmentMutation(ctx, operation)
	if err != nil {
		return completion, err
	}
	return store.Completion{Outcome: w.outcome}, &store.TransactionError{Phase: "cleanup", Outcome: w.outcome, CleanupFailed: true, Cause: errors.New("cleanup failed")}
}

type failingDeleteStorage struct{ filestorage.Storage }

func (f failingDeleteStorage) Delete(context.Context, string, string) error {
	return errors.New("file delete failed")
}

func TestAttachmentRemoveActualCompletionFacts(t *testing.T) {
	_, project, principal, tasks, database, _, _ := taskResourceClient(t)
	task, err := tasks.Create(t.Context(), principal, project, taskcore.CreateTask{Title: "Attachment completion"})
	if err != nil {
		t.Fatal(err)
	}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	original := attachmentservice.NewAttachments(database, database, files)
	actor := RequestActor{Principal: principal, RequestID: "completion-test"}
	input := attachmentInput{ProjectID: project, TaskID: task.ID, Path: "file"}
	for _, tc := range []struct {
		name, want  string
		outcome     store.TransactionOutcome
		fileFailure bool
	}{
		{"file failure", "unknown", store.TransactionNotCommitted, true},
		{"lost receipt", "unknown", store.TransactionUnknown, false},
		{"committed cleanup failure", "confirmed", store.TransactionCommitted, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := original.Put(t.Context(), principal, project, task.ID, "file", "text/plain", strings.NewReader("x")); err != nil {
				t.Fatal(err)
			}
			var subject *attachmentservice.Attachments
			if tc.fileFailure {
				subject = attachmentservice.NewAttachments(database, database, failingDeleteStorage{files})
			} else {
				subject = attachmentservice.NewAttachments(database, attachmentCompletionWriter{database, tc.outcome}, files)
			}
			result, err := removeAttachment(t.Context(), actor, subject, input)
			if err == nil || result.WriteOutcome != tc.want || result.Refs["path"] != "file" {
				t.Fatalf("outcome=%#v error=%v", result, err)
			}
		})
	}
}
