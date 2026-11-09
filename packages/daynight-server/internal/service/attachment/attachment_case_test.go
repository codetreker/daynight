package attachment

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type caseStorageCall struct{ operation, path, content string }
type caseStorage struct {
	*local.Storage
	t     *testing.T
	calls []caseStorageCall
}

func (s *caseStorage) take(operation, bucket, path string) caseStorageCall {
	s.t.Helper()
	if len(s.calls) == 0 {
		s.t.Fatalf("unexpected case storage %s %s/%s", operation, bucket, path)
	}
	call := s.calls[0]
	s.calls = s.calls[1:]
	if operation != call.operation || bucket != "task-attachments" || path != call.path {
		s.t.Fatalf("case storage %s %s/%s, want %+v", operation, bucket, path, call)
	}
	return call
}
func (s *caseStorage) Put(ctx context.Context, bucket, path string, content io.Reader) (filestorage.FileInfo, error) {
	call := s.take("put", bucket, path)
	data, err := io.ReadAll(content)
	if err != nil || string(data) != call.content {
		s.t.Fatalf("case write %q, want %q: %v", data, call.content, err)
	}
	return filestorage.FileInfo{Size: int64(len(call.content))}, nil
}
func (s *caseStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	call := s.take("open", bucket, path)
	return filestorage.Object{Body: io.NopCloser(strings.NewReader(call.content)), Info: filestorage.FileInfo{Size: int64(len(call.content))}}, nil
}

func (s *caseStorage) Delete(context.Context, string, string) error {
	s.t.Error("unexpected case storage delete")
	return errors.New("unexpected case storage delete")
}

func TestAttachmentCaseDistinctPaths(t *testing.T) {
	_, m, files, task, p := attachmentUnit(t)
	controlled := &caseStorage{Storage: files, t: t}
	t.Cleanup(func() {
		if len(controlled.calls) != 0 {
			t.Errorf("unconsumed case storage calls: %+v", controlled.calls)
		}
	})
	subject := NewAttachments(m, m, controlled)
	for _, test := range []struct{ path, content string }{{"Case", "upper"}, {"case", "lower"}} {
		item := attachmentItem(task, test.path, "text/plain", int64(len(test.content)))
		controlled.calls = append(controlled.calls, caseStorageCall{"put", attachmentTestStoragePath(task, test.path), test.content})
		planAttachmentPut(m, p, task, item, true)
		got, created, err := subject.Put(t.Context(), p, task.ProjectID, task.ID, test.path, "text/plain", strings.NewReader(test.content))
		if err != nil || !created || !reflect.DeepEqual(got, item) {
			t.Fatalf("case write: %+v %t %v", got, created, err)
		}
	}
	for _, test := range []struct{ path, content string }{{"Case", "upper"}, {"case", "lower"}} {
		item := attachmentItem(task, test.path, "text/plain", int64(len(test.content)))
		controlled.calls = append(controlled.calls, caseStorageCall{"open", attachmentTestStoragePath(task, test.path), test.content})
		planAttachmentOpen(m, p, task, item)
		_, object, err := subject.Open(t.Context(), p, task.ProjectID, task.ID, test.path)
		if err != nil {
			t.Fatal(err)
		}
		content, readErr := io.ReadAll(object.Body)
		if err := errors.Join(readErr, object.Body.Close()); err != nil || string(content) != test.content {
			t.Fatalf("independent path %s: %q %v", test.path, content, err)
		}
	}
}

func TestAttachmentFilesystemNameConflictPreservesMetadataAndBytes(t *testing.T) {
	attachments, m, files, task, p := attachmentUnit(t)
	original := attachmentItem(task, "Case", "text/plain", 8)
	if _, err := files.Put(t.Context(), "task-attachments", attachmentTestStoragePath(task, "Case"), strings.NewReader("original")); err != nil {
		t.Fatal(err)
	}
	failed := NewAttachments(m, m, attachmentFaultStorage{Storage: files, put: errors.Join(filestorage.ErrPathConflict)})
	m.read(p, task)
	m.mutation(task, store.Completion{Outcome: store.TransactionNotCommitted})
	m.expect("live", task.ProjectID)
	m.conflict(task, "case", false)
	_, created, err := failed.Put(t.Context(), p, task.ProjectID, task.ID, "case", "text/plain", strings.NewReader("rejected"))
	requireFault(t, err, "path_conflict")
	if created || !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("conflict identity lost: %t %v", created, err)
	}
	m.read(p, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 50}).result = store.AttachmentPage{Items: []model.Attachment{original}}
	page, err := attachments.List(t.Context(), p, task.ProjectID, task.ID, model.PageRequest{Limit: 50})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], original) {
		t.Fatalf("configured metadata: %+v %v", page, err)
	}
	planAttachmentOpen(m, p, task, original)
	_, object, err := attachments.Open(t.Context(), p, task.ProjectID, task.ID, "Case")
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil || string(content) != "original" {
		t.Fatalf("refusal changed bytes: %q %v", content, err)
	}
}
