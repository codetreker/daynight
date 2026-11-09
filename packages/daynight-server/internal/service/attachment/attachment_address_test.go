package attachment

import (
	"bytes"
	"context"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type attachmentStorageCall struct{ operation, bucket, path string }
type attachmentRecordedStorage struct {
	filestorage.Storage
	calls []attachmentStorageCall
}

func (s *attachmentRecordedStorage) Put(ctx context.Context, bucket, path string, content io.Reader) (filestorage.FileInfo, error) {
	s.calls = append(s.calls, attachmentStorageCall{"put", bucket, path})
	return s.Storage.Put(ctx, bucket, path, content)
}
func (s *attachmentRecordedStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	s.calls = append(s.calls, attachmentStorageCall{"open", bucket, path})
	return s.Storage.Open(ctx, bucket, path)
}
func (s *attachmentRecordedStorage) Delete(ctx context.Context, bucket, path string) error {
	s.calls = append(s.calls, attachmentStorageCall{"delete", bucket, path})
	return s.Storage.Delete(ctx, bucket, path)
}

func TestAttachmentProjectAndTaskShardIsolation(t *testing.T) {
	_, m, files, task, p := attachmentUnit(t)
	recorded := &attachmentRecordedStorage{Storage: files}
	subject := NewAttachments(m, m, recorded)
	owners := []model.Task{
		task,
		{ProjectID: task.ProjectID, ID: "ab000000-0000-4000-8000-000000000002"},
		{ProjectID: task.ProjectID, ID: "cd000000-0000-4000-8000-000000000003"},
		{ProjectID: "cd000000-0000-4000-8000-000000000002", ID: "ab000000-0000-4000-8000-000000000004"},
	}
	path := "文档 space/same%_?#.bin"
	for i, owner := range owners {
		content := []byte{0, 255, byte(i + 1)}
		item := attachmentItem(owner, path, "application/octet-stream", 3)
		planAttachmentPut(m, p, owner, item, true)
		got, created, err := subject.Put(t.Context(), p, strings.ToUpper(owner.ProjectID), strings.ToUpper(owner.ID), path, item.ContentType, bytes.NewReader(content))
		if err != nil || !created || !reflect.DeepEqual(got, item) {
			t.Fatalf("canonical metadata: %#v %v %v", got, created, err)
		}
		planAttachmentOpen(m, p, owner, item)
		metadata, object, err := subject.Open(t.Context(), p, strings.ToUpper(owner.ProjectID), strings.ToUpper(owner.ID), path)
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if readErr != nil || closeErr != nil || !bytes.Equal(data, content) || !reflect.DeepEqual(metadata, item) {
			t.Fatalf("open: %#v %q %v %v", metadata, data, readErr, closeErr)
		}
		planAttachmentDelete(m, p, owner, item)
		if err := subject.Delete(t.Context(), p, strings.ToUpper(owner.ProjectID), strings.ToUpper(owner.ID), path); err != nil {
			t.Fatal(err)
		}
		expectedPath := owner.ProjectID + "/" + owner.ID[:2] + "/" + owner.ID + "/" + path
		want := []attachmentStorageCall{{"put", "task-attachments", expectedPath}, {"open", "task-attachments", expectedPath}, {"delete", "task-attachments", expectedPath}}
		if got := recorded.calls[len(recorded.calls)-3:]; !reflect.DeepEqual(got, want) {
			t.Fatalf("storage delegation: %#v want %#v", got, want)
		}
	}
	before := len(recorded.calls)
	mismatched := owners[3]
	mismatched.ProjectID = task.ProjectID
	m.read(p, mismatched)
	// The concrete DAO owns resource scoping; the service refuses its missing result.
	m.mu.Lock()
	m.plan[len(m.plan)-1].result = store.TaskPresence{Found: false}
	m.mu.Unlock()
	m.mutation(mismatched, store.Completion{Outcome: store.TransactionNotCommitted})
	m.mu.Lock()
	m.plan[len(m.plan)-1].result = store.TaskPresence{Found: false}
	m.mu.Unlock()
	m.expect("authorize", p, mismatched.ProjectID).result = model.ProjectAccess{}
	_, _, err := subject.Put(t.Context(), p, mismatched.ProjectID, mismatched.ID, path, "application/octet-stream", bytes.NewReader(nil))
	requireFault(t, err, "not_found")
	m.read(p, mismatched)
	m.mu.Lock()
	m.plan[len(m.plan)-1].result = store.TaskPresence{Found: false}
	m.mu.Unlock()
	_, _, err = subject.Open(t.Context(), p, mismatched.ProjectID, mismatched.ID, path)
	requireFault(t, err, "not_found")
	m.mutation(mismatched, store.Completion{Outcome: store.TransactionNotCommitted})
	m.mu.Lock()
	m.plan[len(m.plan)-1].result = store.TaskPresence{Found: false}
	m.mu.Unlock()
	m.expect("authorize", p, mismatched.ProjectID).result = model.ProjectAccess{}
	requireFault(t, subject.Delete(t.Context(), p, mismatched.ProjectID, mismatched.ID, path), "not_found")
	if len(recorded.calls) != before {
		t.Fatal("mismatched address reached file operations")
	}
}
