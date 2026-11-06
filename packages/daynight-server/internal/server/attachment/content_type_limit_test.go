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
)

func TestAttachmentHTTPContentTypeLimit(t *testing.T) {
	files := attachmentTestFiles(t)
	handler := attachmentTestHandler(t, projectTestStore(t), files, io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "MIME limit")
	file := attachmentFilePath(task, "keep")
	prefix, suffix := `text/plain; name="`, `"`
	limit := prefix + strings.Repeat("a", 2048-len(prefix)-len(suffix)) + suffix
	over := limit[:len(limit)-1] + "a" + suffix
	original := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, file, limit, []byte("original")), http.StatusCreated)
	if original.ContentType != limit {
		t.Fatalf("boundary MIME: %q", original.ContentType)
	}
	for _, path := range []string{file, attachmentFilePath(task, "new")} {
		assertProjectError(t, attachmentRequest(handler, http.MethodPut, path, over, []byte("replacement")), http.StatusBadRequest, "invalid_input")
	}
	response := attachmentRequest(handler, http.MethodGet, file, "", nil)
	if response.Code != http.StatusOK || response.Body.String() != "original" || response.Header().Get("Content-Type") != limit {
		t.Fatalf("existing content changed: %d %q", response.Code, response.Body.String())
	}
	page := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], original) {
		t.Fatalf("metadata changed: %+v", page.Items)
	}
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, attachmentFilePath(task, "new"), "", nil), http.StatusNotFound, "not_found")
	if object, err := files.Open(t.Context(), "task-attachments", task.ProjectID+"/"+task.ID[:2]+"/"+task.ID+"/new"); err == nil {
		object.Body.Close()
		t.Fatal("rejected HTTP write created a file")
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("checking rejected file: %v", err)
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("rejected writes changed task")
	}
	defaultMIME := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, "default"), "", nil), http.StatusCreated)
	if defaultMIME.ContentType != "application/octet-stream" {
		t.Fatalf("default MIME: %q", defaultMIME.ContentType)
	}
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, attachmentFilePath(task, "ordinary"), "text/plain", nil), http.StatusCreated)
}
