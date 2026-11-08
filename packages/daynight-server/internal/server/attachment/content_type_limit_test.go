package attachment_test

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentHTTPContentTypeLimit(t *testing.T) {
	files := attachmentTestFiles(t)
	f := newAttachmentFixture(t, files, io.Discard)
	handler, task := f.handler, f.task
	file := attachmentFilePath(task, "keep")
	prefix, suffix := `text/plain; name="`, `"`
	limit := prefix + strings.Repeat("a", 2048-len(prefix)-len(suffix)) + suffix
	over := limit[:len(limit)-1] + "a" + suffix
	item := f.item(task, "keep", limit, 8)
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	original := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, file, limit, []byte("original")), http.StatusCreated)
	f.verify()
	if original.ContentType != limit {
		t.Fatalf("boundary MIME: %q", original.ContentType)
	}
	for _, path := range []string{file, attachmentFilePath(task, "new")} {
		assertProjectError(t, attachmentRequest(handler, http.MethodPut, path, over, []byte("replacement")), http.StatusBadRequest, "invalid_input")
		f.verify()
	}
	f.expectRead(task, item.Path, item, nil)
	response := attachmentRequest(handler, http.MethodGet, file, "", nil)
	f.verify()
	if response.Code != http.StatusOK || response.Body.String() != "original" || response.Header().Get("Content-Type") != limit {
		t.Fatalf("existing content changed: %d %q", response.Code, response.Body.String())
	}
	f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{Items: []model.Attachment{item}}, nil)
	page := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
	f.verify()
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], original) {
		t.Fatalf("metadata changed: %+v", page.Items)
	}
	f.expectRead(task, "new", model.Attachment{}, model.ErrNotFound)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, attachmentFilePath(task, "new"), "", nil), http.StatusNotFound, "not_found")
	f.verify()
	if object, err := files.Open(t.Context(), "task-attachments", task.ProjectID+"/"+task.ID[:2]+"/"+task.ID+"/new"); err == nil {
		object.Body.Close()
		t.Fatal("rejected HTTP write created a file")
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("checking rejected file: %v", err)
	}
	item = f.item(task, "default", "application/octet-stream", 0)
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	defaultMIME := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, "default"), "", nil), http.StatusCreated)
	f.verify()
	if defaultMIME.ContentType != "application/octet-stream" {
		t.Fatalf("default MIME: %q", defaultMIME.ContentType)
	}
	item = f.item(task, "ordinary", "text/plain", 0)
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, "ordinary"), "text/plain", nil), http.StatusCreated)
	f.verify()
}
