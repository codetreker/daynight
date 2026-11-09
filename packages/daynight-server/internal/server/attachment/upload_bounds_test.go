package attachment_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
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

func TestAttachmentHTTPOverflowWithMissingChunkFraming(t *testing.T) {
	for _, chunked := range []bool{false, true} {
		t.Run(map[bool]string{false: "content length", true: "chunked"}[chunked], func(t *testing.T) {
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
			f := newAttachmentFixture(t, files, logs)
			handler, task := f.handler, f.task
			location := attachmentFilePath(task, "overflow.bin")
			f.expectAdmission(task, "overflow.bin")
			type observation struct {
				native        bool
				before, after error
			}
			finished := make(chan observation, 1)
			logger := slog.New(slog.NewJSONHandler(logs, nil))
			routes := attachmenthttp.PathGuard(f.mux, logger)
			// Observe the actual native body without replacing it: Close must
			// consume the missing framing on net/http's own socket reader.
			handler.Handler = httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				native, before := httpx.NativeHTTP1RequestBody(r), r.Context().Err()
				routes.ServeHTTP(w, r)
				if r.Header.Get("X-Request-ID") != "attachment-overflow-framing" {
					return
				}
				finished <- observation{native: native, before: before, after: r.Context().Err()}
			}))
			server := httptest.NewServer(handler)
			t.Cleanup(server.Close)
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = conn.Close() })
			if err := conn.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
				t.Fatal(err)
			}
			const requestID = "attachment-overflow-framing"
			framing := fmt.Sprintf("Content-Length: %d\r\n\r\n", attachmentcore.MaxFileBytes+1)
			if chunked {
				framing = fmt.Sprintf("Transfer-Encoding: chunked\r\n\r\n%x\r\n", attachmentcore.MaxFileBytes+1)
			}
			if _, err := fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nX-Request-ID: %s\r\n%s", location, handler.token, requestID, framing); err != nil {
				t.Fatal(err)
			}
			if _, err := io.Copy(conn, strings.NewReader(strings.Repeat("x", int(attachmentcore.MaxFileBytes)+1))); err != nil {
				t.Fatal(err)
			}
			// Withhold the chunk delimiter and terminal framing. Once the
			// overflow is read, the server may already close the socket.
			var observed observation
			select {
			case observed = <-finished:
			case <-time.After(10 * time.Second):
				t.Fatal("overflow handler did not finish")
			}
			f.verify()
			if !observed.native || observed.before != nil || chunked && !errors.Is(observed.after, context.Canceled) || !chunked && observed.after != nil {
				t.Fatalf("native overflow lifecycle: %+v", observed)
			}
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(response.Body)
			closeErr := response.Body.Close()
			if readErr != nil || closeErr != nil || response.StatusCode != http.StatusRequestEntityTooLarge || response.Close != chunked || !bytes.Contains(body, []byte(`"code":"payload_too_large"`)) || !bytes.Contains(body, []byte(`"requestId":"`+requestID+`"`)) || response.Header.Get("X-Request-ID") != requestID {
				t.Fatalf("overflow response: status=%d close=%v body=%s read=%v close=%v", response.StatusCode, response.Close, body, readErr, closeErr)
			}
			if chunked {
				if _, err := reader.ReadByte(); !errors.Is(err, io.EOF) {
					t.Fatalf("overflow connection remained reusable: %v", err)
				}
			}
			if count, size, _ := stagingFiles(t, root); count != 0 {
				t.Fatalf("overflow left staging: count=%d size=%d", count, size)
			}
			if _, err := os.Stat(filepath.Join(root, "task-attachments", task.ProjectID, task.ID[:2], task.ID, "overflow.bin")); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("overflow published content: %v", err)
			}
			f.expectRead(task, "overflow.bin", model.Attachment{}, model.ErrNotFound)
			if chunked {
				assertProjectError(t, attachmentRequest(handler, http.MethodGet, location, "", nil), http.StatusNotFound, "not_found")
			} else {
				if _, err := fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n", location, handler.token); err != nil {
					t.Fatal(err)
				}
				next, err := http.ReadResponse(reader, nil)
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(next.Body)
				closeErr := next.Body.Close()
				if next.StatusCode != http.StatusNotFound || readErr != nil || closeErr != nil || !bytes.Contains(data, []byte(`"code":"not_found"`)) {
					t.Fatalf("complete overflow damaged keepalive: status=%d read=%v close=%v", next.StatusCode, readErr, closeErr)
				}
			}
			f.verify()
			item := f.item(task, "overflow.bin", "text/plain", 5)
			f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
			decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, location, "text/plain", []byte("after")), http.StatusCreated)
			f.verify()
			if !logs.contains(`"error_code":"payload_too_large"`) || !logs.contains(`"request_id":"`+requestID+`"`) || logs.contains(handler.token) || logs.contains(root) {
				t.Fatal("overflow diagnostics lost identity or exposed private data")
			}
		})
	}
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
