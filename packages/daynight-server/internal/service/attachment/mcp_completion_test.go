package attachment

import (
	"errors"
	"os"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

func TestMCPDeletePreservesCommittedCleanupFact(t *testing.T) {
	subject, mock, files, task, principal := attachmentUnit(t)
	principal.Kind = model.PATCredential
	item := attachmentItem(task, "file", "text/plain", 1)
	if _, err := files.Put(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, item.Path), strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("cleanup failed")
	completion := mock.mutation(task, store.Completion{Outcome: store.TransactionCommitted})
	completion.err = &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: cause}
	mock.expect("authorize", principal, task.ProjectID).result = model.ProjectAccess{}
	mock.metadata(task, item)
	mock.expect("metadataDelete", task.ProjectID, task.ID, item.Path)
	err := subject.Delete(t.Context(), principal, task.ProjectID, task.ID, item.Path)
	facts := operation.CompletionFacts(err)
	if !errors.Is(err, cause) || !FileEffectPossible(err) || facts.Outcome != store.TransactionCommitted || !facts.CleanupFailed {
		t.Fatalf("delete completion: facts=%+v error=%v", facts, err)
	}
	if object, err := files.Open(t.Context(), attachmentcore.Bucket, attachmentTestStoragePath(task, item.Path)); err == nil {
		_ = object.Body.Close()
		t.Fatal("physical file survived completed delete")
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("observe removed file: %v", err)
	}
}
