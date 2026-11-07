package attachment_test

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
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
	handler := attachmentTestHandler(t, projectTestStore(t), attachmentTestFiles(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Bounded upload")
	location := attachmentFilePath(task, "limit.bin")
	payload := bytes.Repeat([]byte("x"), int(attachmentcore.MaxFileBytes))

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
		return response.StatusCode, body
	}
	for _, chunked := range []bool{false, true} {
		status, body := put(payload, chunked, "application/octet-stream")
		if want := http.StatusCreated; status != want && status != http.StatusOK {
			t.Fatalf("maximum body (chunked=%v): %d %s", chunked, status, body)
		}
		before := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
		status, body = put(append(bytes.Clone(payload), 'y'), chunked, "text/plain")
		if status != http.StatusRequestEntityTooLarge || !bytes.Contains(body, []byte(`"code":"payload_too_large"`)) {
			t.Fatalf("oversized body (chunked=%v): %d %s", chunked, status, body)
		}
		after := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
		file := attachmentRequest(handler, http.MethodGet, location, "", nil)
		if !reflect.DeepEqual(before, after) || file.Code != http.StatusOK || !bytes.Equal(file.Body.Bytes(), payload) || !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
			t.Fatal("oversized overwrite changed attachment bytes, metadata, or Task")
		}
	}

	reader := &countedReader{reader: bytes.NewReader(bytes.Repeat([]byte("z"), int(attachmentcore.MaxFileBytes)+(1<<20)))}
	request := httptest.NewRequest(http.MethodPut, attachmentFilePath(task, "new.bin"), reader)
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusRequestEntityTooLarge, "payload_too_large")
	if reader.read != attachmentcore.MaxFileBytes+1 {
		t.Fatalf("oversized body read %d bytes", reader.read)
	}
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, attachmentFilePath(task, "new.bin"), "", nil), http.StatusNotFound, "not_found")
}

func TestAttachmentHTTPReadDeadlineReleasesUpload(t *testing.T) {
	handler := attachmentTestHandler(t, projectTestStore(t), attachmentTestFiles(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Slow upload")
	location := attachmentFilePath(task, "slow.bin")
	server := httptest.NewServer(handler)
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(transport.AttachmentBodyReadTimeout + 15*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nContent-Length: 2\r\n\r\nx", location, handler.token); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != http.StatusRequestTimeout || !bytes.Contains(body, []byte(`"code":"request_timeout"`)) {
		t.Fatalf("stalled upload: %d %s read=%v close=%v", response.StatusCode, body, readErr, closeErr)
	}
	assertProjectError(t, attachmentRequest(handler, http.MethodGet, location, "", nil), http.StatusNotFound, "not_found")
	decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, location, "text/plain", []byte("after")), http.StatusCreated)
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("stalled upload changed Task")
	}
}
