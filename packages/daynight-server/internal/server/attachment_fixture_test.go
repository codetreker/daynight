package server

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
)

func attachmentTestFiles(t *testing.T) *local.Storage {
	t.Helper()
	return attachmentTestFilesAt(t, t.TempDir())
}

func attachmentTestFilesAt(t *testing.T, root string) *local.Storage {
	t.Helper()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return files
}

func attachmentRequest(handler http.Handler, method, target, contentType string, content []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, bytes.NewReader(content))
	authorizeResourceRequest(handler, request)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func attachmentFilePath(task api.Task, file string) string {
	segments := strings.Split(file, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return taskPath(task) + "/attachments/files/" + strings.Join(segments, "/")
}

type attachmentFailingBody struct {
	data     []byte
	readErr  error
	closeErr error
	closed   bool
	cancel   context.CancelFunc
}

func (r *attachmentFailingBody) Read(buffer []byte) (int, error) {
	if r.cancel != nil {
		r.cancel()
	}
	count := copy(buffer, r.data)
	r.data = r.data[count:]
	if len(r.data) == 0 {
		if r.readErr != nil {
			return count, r.readErr
		}
		return count, io.EOF
	}
	return count, nil
}

func (r *attachmentFailingBody) Close() error {
	r.closed = true
	return r.closeErr
}
