package attachment_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mutationCountingStorage struct {
	filestorage.Storage
	puts, deletes int
}

func (s *mutationCountingStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	s.puts++
	return s.Storage.Put(ctx, bucket, path, body)
}

func (s *mutationCountingStorage) Delete(ctx context.Context, bucket, path string) error {
	s.deletes++
	return s.Storage.Delete(ctx, bucket, path)
}

func TestAttachmentHTTPMutationsAfterTaskDeletionPreserveFiles(t *testing.T) {
	ctx := context.Background()
	files := attachmentTestFiles(t)
	storage := &mutationCountingStorage{Storage: files}
	f := newAttachmentFixture(t, storage, io.Discard)
	handler, task := f.handler, f.task
	const retained, content = "docs/retained.txt", "original bytes"
	item := f.item(task, retained, "text/plain", int64(len(content)))
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, retained), "text/plain", []byte(content)), http.StatusCreated)
	f.verify()
	deletedAt := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	presence := store.TaskPresence{Found: true, DeletedAt: &deletedAt}
	storage.puts, storage.deletes = 0, 0
	for _, call := range []struct{ method, path, body string }{
		{http.MethodPut, "docs/new.txt", "new bytes"},
		{http.MethodPut, retained, "replacement"},
		{http.MethodDelete, retained, ""},
	} {
		if call.method == http.MethodPut {
			f.expectReadFailure(task, nil, presence)
			f.expectMutationFailure(task, true, presence, nil)
		} else {
			f.begin()
			f.expectMutationFailure(task, true, presence, nil)
		}
		response := attachmentRequest(handler, call.method, attachmentFilePath(task, call.path), "text/plain", []byte(call.body))
		assertProjectError(t, response, http.StatusGone, "task_deleted")
		f.verify()
	}
	if storage.puts != 0 || storage.deletes != 0 {
		t.Fatalf("deleted Task reached file mutation: puts=%d deletes=%d", storage.puts, storage.deletes)
	}
	physical := task.ProjectID + "/" + task.ID[:2] + "/" + task.ID + "/"
	object, err := files.Open(ctx, "task-attachments", physical+retained)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil || string(data) != content {
		t.Fatalf("retained file: %q, %v", data, err)
	}
	_, err = files.Open(ctx, "task-attachments", physical+"docs/new.txt")
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("new file appeared after Task deletion: %v", err)
	}
}
