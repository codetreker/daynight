package attachment_test

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentHTTPInterruptedUploadDiscardsStaging(t *testing.T) {
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	}()
	f := newAttachmentFixture(t, files, io.Discard)
	handler, task := f.handler, f.task
	f.expectAdmission(task, "interrupted/file.bin")
	location := attachmentFilePath(task, "interrupted/file.bin")
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.URL.Path == location {
			defer close(finished)
		}
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	prefix := bytes.Repeat([]byte("partial-"), 1024)
	if _, err := fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\n\r\n", location, server.Listener.Addr(), handler.token, len(prefix)*2); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(prefix); err != nil {
		t.Fatal(err)
	}
	staging := func() (int, int64) {
		t.Helper()
		count := 0
		var size int64
		err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !entry.IsDir() && strings.HasPrefix(entry.Name(), ".daynight-upload-") {
				info, err := entry.Info()
				if err != nil {
					return err
				}
				count++
				size += info.Size()
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return count, size
	}
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		count, size := staging()
		if count == 1 && size == int64(len(prefix)) {
			break
		}
		select {
		case <-finished:
			t.Fatal("upload returned before the partial body was disconnected")
		case <-deadline.C:
			t.Fatalf("partial upload did not reach staging: count=%d size=%d", count, size)
		case <-ticker.C:
		}
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not return after disconnect")
	}
	if count, size := staging(); count != 0 {
		t.Fatalf("disconnected upload left staging: count=%d size=%d", count, size)
	}
	f.verify()
	f.expectRead(task, "interrupted/file.bin", model.Attachment{}, model.ErrNotFound)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, location, "", nil), http.StatusNotFound, "not_found")
	f.verify()
	f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{}, nil)
	page := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
	f.verify()
	if len(page.Items) != 0 {
		t.Fatalf("disconnected upload exposed attachment metadata: %+v", page)
	}
	if _, err := os.Stat(filepath.Join(root, "task-attachments", task.ProjectID, task.ID[:2], task.ID, "interrupted", "file.bin")); !os.IsNotExist(err) {
		t.Fatalf("disconnected upload published a file: %v", err)
	}
}
