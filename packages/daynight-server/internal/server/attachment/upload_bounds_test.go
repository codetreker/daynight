package attachment_test

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
)

type countedReader struct {
	reader io.Reader
	read   int64
}

func (r *countedReader) Read(p []byte) (int, error) {
	n, err := r.reader.Read(p)
	r.read += int64(n)
	return n, err
}

func TestAttachmentHTTPUploadByteLimit(t *testing.T) {
	files := attachmentTestFiles(t)
	f := newAttachmentFixture(t, files, io.Discard)
	handler, task := f.handler, f.task
	location := attachmentFilePath(task, "limit.bin")
	payload := bytes.Repeat([]byte("x"), int(attachmentcore.MaxFileBytes))
	item := f.item(task, "limit.bin", "application/octet-stream", int64(len(payload)))
	server := httptest.NewServer(handler)
	defer server.Close()
	client := server.Client()
	client.Timeout = 30 * time.Second
	put := func(content []byte, chunked bool, mime string) (int, []byte) {
		t.Helper()
		request, err := http.NewRequest(http.MethodPut, server.URL+location, bytes.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		authorizeResourceRequest(handler, request)
		request.Header.Set("Content-Type", mime)
		if chunked {
			request.ContentLength = -1
			request.TransferEncoding = []string{"chunked"}
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		if closeErr := response.Body.Close(); err != nil || closeErr != nil {
			t.Fatalf("read response: %v; close: %v", err, closeErr)
		}
		f.verify()
		return response.StatusCode, body
	}
	for index, chunked := range []bool{false, true} {
		f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, index == 0)
		status, body := put(payload, chunked, item.ContentType)
		want := http.StatusCreated
		if index != 0 {
			want = http.StatusOK
		}
		if status != want {
			t.Fatalf("maximum body (chunked=%v): %d %s", chunked, status, body)
		}
		f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{Items: []model.Attachment{item}}, nil)
		before := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
		f.verify()
		f.expectAdmission(task, "limit.bin")
		status, body = put(append(bytes.Clone(payload), 'y'), chunked, "text/plain")
		if status != http.StatusRequestEntityTooLarge || !bytes.Contains(body, []byte(`"code":"payload_too_large"`)) {
			t.Fatalf("oversized body (chunked=%v): %d %s", chunked, status, body)
		}
		f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{Items: []model.Attachment{item}}, nil)
		after := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
		f.verify()
		f.expectRead(task, item.Path, item, nil)
		file := attachmentRequest(handler, http.MethodGet, location, "", nil)
		f.verify()
		if len(before.Items) != 1 || len(after.Items) != 1 || before.Items[0] != after.Items[0] || file.Code != http.StatusOK || !bytes.Equal(file.Body.Bytes(), payload) {
			t.Fatal("oversized overwrite changed content or metadata response")
		}
	}
	reader := &countedReader{reader: bytes.NewReader(bytes.Repeat([]byte("z"), int(attachmentcore.MaxFileBytes)+(1<<20)))}
	f.expectAdmission(task, "new.bin")
	request := httptest.NewRequest(http.MethodPut, attachmentFilePath(task, "new.bin"), reader)
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	f.verify()
	assertProjectError(t, response, http.StatusRequestEntityTooLarge, "payload_too_large")
	if reader.read != attachmentcore.MaxFileBytes+1 {
		t.Fatalf("oversized body read %d bytes", reader.read)
	}
	f.expectRead(task, "new.bin", model.Attachment{}, model.ErrNotFound)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, attachmentFilePath(task, "new.bin"), "", nil), http.StatusNotFound, "not_found")
	f.verify()
}

type observedBodyClose struct {
	io.ReadCloser
	once   sync.Once
	closed chan struct{}
}

func (b *observedBodyClose) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() { close(b.closed) })
	return err
}

func stagingFiles(t *testing.T, root string) (int, int64, []byte) {
	t.Helper()
	count := 0
	var size int64
	var data []byte
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
			data, err = os.ReadFile(path)
			return err
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return count, size, data
}

func waitForStagedPrefix(t *testing.T, root string, prefix []byte, finished <-chan struct{}) {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		count, size, data := stagingFiles(t, root)
		if count == 1 && size == int64(len(prefix)) && bytes.Equal(data, prefix) {
			return
		}
		select {
		case <-finished:
			t.Fatal("upload returned before the staged-byte barrier")
		case <-deadline.C:
			t.Fatalf("upload did not reach staging: count=%d size=%d", count, size)
		case <-ticker.C:
		}
	}
}

func TestAttachmentHTTPReadDeadlineReleasesUpload(t *testing.T) {
	if transport.AttachmentBodyReadTimeout != time.Minute || attachmenthttp.DefaultBodyReadTimeout() != time.Minute {
		t.Fatalf("production body timeout: %s", transport.AttachmentBodyReadTimeout)
	}
	root := t.TempDir()
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	logs := &admissionSafeLog{}
	f := newAttachmentFixtureWithTimeout(t, files, logs, 200*time.Millisecond)
	handler, task := f.handler, f.task
	location := attachmentFilePath(task, "slow.bin")
	f.expectAdmission(task, "slow.bin")
	finished, closed := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = &observedBodyClose{ReadCloser: r.Body, closed: closed}
		defer close(finished)
		handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	const requestID = "stalled-attachment"
	if _, err := fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\nX-Request-ID: %s\r\n\r\nx", location, handler.token, requestID); err != nil {
		t.Fatal(err)
	}
	waitForStagedPrefix(t, root, []byte("x"), finished)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != http.StatusRequestTimeout || !bytes.Contains(body, []byte(`"code":"request_timeout"`)) || response.Header.Get("X-Request-ID") != requestID || !response.Close {
		t.Fatalf("stalled upload: %d %s read=%v close=%v headers=%v", response.StatusCode, body, readErr, closeErr, response.Header)
	}
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("timeout handler did not finish")
	}
	select {
	case <-closed:
	default:
		t.Fatal("timeout left request body open")
	}
	f.verify()
	if _, err := reader.ReadByte(); !errors.Is(err, io.EOF) {
		t.Fatalf("timeout connection remained reusable: %v", err)
	}
	if count, size, _ := stagingFiles(t, root); count != 0 {
		t.Fatalf("timeout left staging: count=%d size=%d", count, size)
	}
	if _, err := os.Stat(filepath.Join(root, "task-attachments", task.ProjectID, task.ID[:2], task.ID, "slow.bin")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("timeout published file: %v", err)
	}
	f.expectRead(task, "slow.bin", model.Attachment{}, model.ErrNotFound)
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, location, "", nil), http.StatusNotFound, "not_found")
	f.verify()
	item := f.item(task, "slow.bin", "text/plain", 5)
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, location, "text/plain", []byte("after")), http.StatusCreated)
	f.verify()
	if !logs.contains(`"error_code":"request_timeout"`) || !logs.contains(`"request_id":"`+requestID+`"`) || logs.contains(handler.token) || logs.contains(root) {
		t.Fatal("timeout diagnostic lost request identity or exposed private data")
	}
}
