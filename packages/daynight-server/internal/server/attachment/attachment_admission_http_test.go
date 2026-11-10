package attachment_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type admissionSafeLog struct {
	mu   sync.Mutex
	data bytes.Buffer
}

func (l *admissionSafeLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.data.Write(data)
}

func (l *admissionSafeLog) contains(value string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Contains(l.data.String(), value)
}

func admissionRequest(t *testing.T, client *http.Client, method, address, body string, headers map[string]string, status int) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, address, strings.NewReader(body))
	if err != nil {
		t.Fatal("could not create fixture request")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("fixture request failed")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != status {
		t.Fatalf("fixture response: status=%d want=%d read=%v close=%v", response.StatusCode, status, readErr, closeErr)
	}
	return response, data
}

func admissionDecode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal("fixture response was invalid JSON")
	}
	return value
}

func TestAttachmentHTTPAdmittedStreamSurvivesMemberRevocation(t *testing.T) {
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
	handler, task, project := f.handler, f.task, f.project
	memberToken := handler.token
	memberID := handler.principal.UserID
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	origin := server.URL
	location := attachmentFilePath(task, "admission/complete.bin")
	prefix := bytes.Repeat([]byte{0, 0xff, 0x80, 'a'}, 4096)
	suffix := bytes.Repeat([]byte{'b', 0x01, '\n', 0xfe}, 4096)
	content := append(append([]byte{}, prefix...), suffix...)
	item := f.item(task, "admission/complete.bin", "application/octet-stream", int64(len(content)))
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	connection, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	type uploadResult struct {
		status int
		header http.Header
		body   []byte
		err    error
	}
	result := make(chan uploadResult, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPut})
		if err != nil {
			result <- uploadResult{err: err}
			return
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		closeErr := response.Body.Close()
		if readErr == nil {
			readErr = closeErr
		}
		result <- uploadResult{status: response.StatusCode, header: response.Header, body: body, err: readErr}
	}()
	t.Cleanup(func() {
		_ = connection.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("stream response reader did not exit")
		}
	})
	const requestID = "admitted-upload"
	if _, err := fmt.Fprintf(connection, "PUT %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\nX-Request-ID: %s\r\nConnection: close\r\n\r\n", location, server.Listener.Addr(), memberToken, len(content), requestID); err != nil {
		t.Fatal("could not send upload headers")
	}
	if _, err := io.Copy(connection, bytes.NewReader(prefix)); err != nil {
		t.Fatal("could not send upload prefix")
	}
	staging := func() (int, int64, []byte) {
		t.Helper()
		count := 0
		var size int64
		var data []byte
		if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
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
				if info.Size() == int64(len(prefix)) {
					data, err = os.ReadFile(path)
					return err
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return count, size, data
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		count, size, data := staging()
		if count == 1 && size == int64(len(prefix)) && bytes.Equal(data, prefix) {
			break
		}
		select {
		case got := <-result:
			t.Fatalf("upload ended before admission barrier: status=%d error=%v", got.status, got.err)
		case <-ctx.Done():
			t.Fatalf("upload prefix was not staged: count=%d size=%d", count, size)
		case <-ticker.C:
		}
	}
	finalPath := filepath.Join(root, "task-attachments", project.ID, task.ID[:2], task.ID, "admission", "complete.bin")
	if _, err := os.Stat(finalPath); !os.IsNotExist(err) {
		t.Fatalf("incomplete upload published a file: %v", err)
	}
	// The next read sees the revoked grant; the in-flight mutation has already
	// consumed its authorization snapshot and can only recheck lifecycle.
	f.prepareReadFailure(task, model.ErrNotFound, store.TaskPresence{Found: true})
	select {
	case got := <-result:
		t.Fatalf("upload completed before the remaining bytes: status=%d error=%v", got.status, got.err)
	default:
	}
	if count, size, data := staging(); count != 1 || size != int64(len(prefix)) || !bytes.Equal(data, prefix) {
		t.Fatalf("revocation changed incomplete upload: count=%d size=%d", count, size)
	}
	if _, err := io.Copy(connection, bytes.NewReader(suffix)); err != nil {
		t.Fatal("could not send upload suffix")
	}
	var completed uploadResult
	select {
	case completed = <-result:
	case <-ctx.Done():
		t.Fatal("admitted upload did not finish")
	}
	if completed.err != nil || completed.status != http.StatusCreated || completed.header.Get("Content-Type") != "application/json" || completed.header.Get("X-Request-ID") != requestID || completed.header.Get("Daynight-User-ID") != memberID {
		t.Fatalf("admitted upload response: status=%d error=%v", completed.status, completed.err)
	}
	metadata := admissionDecode[api.Attachment](t, completed.body)
	if metadata.Path != "admission/complete.bin" || metadata.SizeBytes != int64(len(content)) || metadata.ContentType != "application/octet-stream" {
		t.Fatalf("admitted upload metadata: %+v", metadata)
	}
	ownerFixture := newAttachmentFixture(t, files, io.Discard)
	ownerFixture.expectRead(task, "admission/complete.bin", item, nil)
	ownerResponse := attachmentRequest(ownerFixture.handler, http.MethodGet, location, "", nil)
	ownerFixture.verify()
	if ownerResponse.Code != http.StatusOK || !bytes.Equal(ownerResponse.Body.Bytes(), content) {
		t.Fatal("admitted upload did not preserve the complete bytes")
	}
	_, denial := admissionRequest(t, server.Client(), http.MethodGet, origin+location, "", map[string]string{"Authorization": "Bearer " + memberToken}, http.StatusNotFound)
	if admissionDecode[api.ErrorResponse](t, denial).Error.Code != "not_found" {
		t.Fatal("revoked member retained attachment access")
	}
	f.verify()
	if count, size, _ := staging(); count != 0 {
		t.Fatalf("completed upload left staging: count=%d size=%d", count, size)
	}
	if logs.contains(memberToken) {
		t.Fatal("upload or authorization diagnostics exposed a credential")
	}
}
