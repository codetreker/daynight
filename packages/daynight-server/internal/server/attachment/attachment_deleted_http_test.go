package attachment_test

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
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
	database, files := projectTestStore(t), attachmentTestFiles(t)
	storage := &mutationCountingStorage{Storage: files}
	handler := attachmentTestHandler(t, database, storage, io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Retained attachment")
	const retained, content = "docs/retained.txt", "original bytes"
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, retained), "text/plain", []byte(content)), http.StatusCreated)

	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT to_jsonb(a)::text FROM task_attachments a WHERE project_id=$1 AND task_id=$2 AND path=$3`, project.ID, task.ID, retained).Scan(&before); err != nil {
		t.Fatal(err)
	}
	deleted := projectRequest(handler, http.MethodDelete, taskPath(task), jsonBody(t, api.TaskDeleteRequest{Version: task.Version}))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete Task: %d %s", deleted.Code, deleted.Body)
	}
	storage.puts, storage.deletes = 0, 0
	for _, call := range []struct{ method, path, body string }{
		{http.MethodPut, "docs/new.txt", "new bytes"},
		{http.MethodPut, retained, "replacement"},
		{http.MethodDelete, retained, ""},
	} {
		response := attachmentRequest(handler, call.method, attachmentFilePath(task, call.path), "text/plain", []byte(call.body))
		assertProjectError(t, response, http.StatusGone, "task_deleted")
	}
	if storage.puts != 0 || storage.deletes != 0 {
		t.Fatalf("deleted Task reached file mutation: puts=%d deletes=%d", storage.puts, storage.deletes)
	}
	var after string
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT to_jsonb(a)::text, (SELECT count(*) FROM task_attachments WHERE task_id=$2) FROM task_attachments a WHERE project_id=$1 AND task_id=$2 AND path=$3`, project.ID, task.ID, retained).Scan(&after, &count); err != nil || after != before || count != 1 {
		t.Fatalf("retained metadata changed: before=%s after=%s count=%d err=%v", before, after, count, err)
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
