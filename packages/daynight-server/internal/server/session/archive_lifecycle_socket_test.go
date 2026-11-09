package session_test

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

// The wrapper verifies the production deadline and shortens only the actual
// socket deadline so this socket test does not wait two minutes.
type archiveWriteDeadlineObserver struct {
	http.ResponseWriter
	started  chan struct{}
	deadline chan time.Time
	once     sync.Once
}

func (w *archiveWriteDeadlineObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *archiveWriteDeadlineObserver) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		select {
		case w.deadline <- deadline:
		default:
		}
		deadline = time.Now().Add(3 * time.Second)
	}
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}
func (w *archiveWriteDeadlineObserver) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	return w.ResponseWriter.Write(data)
}

func TestArchiveSendDeadlineRetainsAndReleasesCapacity(t *testing.T) {
	f := archiveHTTPSetup(t)
	f.Declare("preflight", archivePreflightCounts(), false)
	f.Declare("upload", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveReady": 1}), false)
	f.Declare("read", archiveScopeCounts(false, map[string]int{"SessionArchive": 1}), false)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	f.UseEndedTaskInput()
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	// Whitespace is valid archive input and must remain byte-for-byte intact.
	raw := jsonBody(t, doc) + strings.Repeat(" ", 16*1024*1024)
	if response := f.Request(http.MethodPut, base, raw, "preflight", "upload"); response.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}
	f.AcceptReady(t, []byte(raw))
	started := make(chan struct{})
	deadline := make(chan time.Time, 1)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		f.handler.Handler.ServeHTTP(&archiveWriteDeadlineObserver{ResponseWriter: w, started: started, deadline: deadline}, r)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.(*net.TCPConn).SetReadBuffer(64 * 1024); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err = fmt.Fprintf(conn, "GET %s/content HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nDaynight-Test-Scopes: preflight,read\r\n\r\n", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("archive response did not start")
	}
	select {
	case got := <-deadline:
		remaining := time.Until(got)
		if remaining < 115*time.Second || remaining > 121*time.Second {
			t.Fatalf("production deadline: %v", remaining)
		}
	default:
		t.Fatal("archive write deadline not set")
	}
	authCalls := f.auth.Count()
	if response := f.Request(http.MethodGet, base+"/content", ""); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), `"resource_busy"`) {
		t.Fatalf("capacity during send: %d %s", response.Code, response.Body.String())
	}
	if f.auth.Count() != authCalls {
		t.Fatal("saturated archive send authenticated another request")
	}
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("non-reading peer did not release the timed-out send")
	}
	if err := conn.(*net.TCPConn).SetReadBuffer(1024 * 1024); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetDeadline(time.Now().Add(20 * time.Second)); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, readErr := io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if !errors.Is(readErr, io.ErrUnexpectedEOF) {
		t.Fatalf("interrupted response did not close: %v", readErr)
	}
	got := f.Request(http.MethodGet, base+"/content", "", "preflight", "read")
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), append(append([]byte(`{"archive":`), []byte(raw)...), '}')) {
		t.Fatalf("capacity or raw bytes after failure: status %d, length %d", got.Code, got.Body.Len())
	}
}

type archiveReadDeadlineObserver struct {
	http.ResponseWriter
	deadline chan time.Time
}

func (w *archiveReadDeadlineObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *archiveReadDeadlineObserver) SetReadDeadline(deadline time.Time) error {
	if deadline.After(time.Now().Add(time.Minute)) {
		select {
		case w.deadline <- deadline:
		default:
		}
		deadline = time.Now().Add(3 * time.Second)
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func TestArchiveUploadClientDisconnectReleasesCapacity(t *testing.T) {
	f := archiveHTTPSetup(t)
	f.Declare("preflight", archivePreflightCounts(), false)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	deadline := make(chan time.Time, 1)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		f.handler.Handler.ServeHTTP(&archiveReadDeadlineObserver{ResponseWriter: w, deadline: deadline}, r)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\nDaynight-Test-Scopes: preflight\r\n\r\n{", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-deadline:
		remaining := time.Until(got)
		if remaining < 115*time.Second || remaining > 121*time.Second {
			t.Fatalf("production read deadline: %v", remaining)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("archive read deadline not set")
	}
	authCalls := f.auth.Count()
	if response := f.Request(http.MethodPut, base, "{}"); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), `"resource_busy"`) {
		t.Fatalf("capacity during upload: %d %s", response.Code, response.Body.String())
	}
	if f.auth.Count() != authCalls {
		t.Fatal("saturated archive upload authenticated another request")
	}
	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("disconnected upload did not finish")
	}
	if response := f.Request(http.MethodPut, base, "{}", "preflight"); response.Code != http.StatusBadRequest {
		t.Fatalf("capacity after disconnect: %d %s", response.Code, response.Body.String())
	}
}

func TestArchivePreflightRejectsBeforeAuthenticationWhileBodyIsUnread(t *testing.T) {
	f := archiveHTTPSetup(t)
	f.Declare("preflight", archivePreflightCounts(), false)
	f.Declare("upload", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveReady": 1}), false)
	deadline := make(chan time.Time, 1)
	finished := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPut && r.Header.Get("X-Test-Stall") == "1" {
			defer close(finished)
			w = &exactReadDeadlineTestObserver{ResponseWriter: w, deadline: deadline}
		}
		f.handler.Handler.ServeHTTP(w, r)
	}))
	defer server.Close()
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\nX-Test-Stall: 1\r\nDaynight-Test-Scopes: preflight\r\n\r\n{", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	select {
	case <-deadline:
	case <-time.After(5 * time.Second):
		t.Fatal("first upload was not admitted")
	}
	authCalls := f.auth.Count()
	for _, tc := range []struct{ method, path, protocol string }{
		{http.MethodPut, base, ""}, {http.MethodGet, base + "/content", ""},
		{http.MethodPut, base, v2.Protocol}, {http.MethodGet, base + "/content", v2.Protocol},
		{http.MethodPut, "/api/v1/test-sessions/" + f.snapshot.SessionID + "/archive", ""},
		{http.MethodGet, "/api/v1/test-sessions/" + f.snapshot.SessionID + "/archive/content", ""},
	} {
		requestCtx, stop := context.WithTimeout(context.Background(), time.Second)
		req, err := http.NewRequestWithContext(requestCtx, tc.method, server.URL+tc.path, strings.NewReader("{}"))
		if err != nil {
			stop()
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+f.handler.token)
		req.Header.Set("Content-Type", "application/json")
		if tc.protocol != "" {
			req.Header.Set(v2.ProtocolHeader, tc.protocol)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			stop()
			t.Fatalf("%s %s blocked before admission: %v", tc.method, tc.path, err)
		}
		data, readErr := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		stop()
		if readErr != nil || resp.StatusCode != http.StatusTooManyRequests || !bytes.Contains(data, []byte(`"resource_busy"`)) {
			t.Fatalf("%s %s: %d %q %v", tc.method, tc.path, resp.StatusCode, data, readErr)
		}
		if tc.method == http.MethodPut && !resp.Close {
			t.Fatalf("%s %s reused an unread-body connection", tc.method, tc.path)
		}
	}
	if f.auth.Count() != authCalls {
		t.Fatal("saturated archive routes authenticated another request")
	}
	_ = conn.Close()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("disconnected upload did not finish")
	}
	f.UseEndedTaskInput()
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	raw := jsonBody(t, doc)
	if response := f.Request(http.MethodPut, base, raw, "preflight", "upload"); response.Code != http.StatusOK {
		t.Fatalf("capacity after drain: %d %s", response.Code, response.Body.String())
	}
	f.AcceptReady(t, []byte(raw))
}

type exactReadDeadlineTestObserver struct {
	http.ResponseWriter
	deadline chan time.Time
}

func (w *exactReadDeadlineTestObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *exactReadDeadlineTestObserver) SetReadDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		select {
		case w.deadline <- deadline:
		default:
		}
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

type blockingArchiveStorage struct {
	filestorage.Storage
	entered, release chan struct{}
}

func (s *blockingArchiveStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	if bucket == sessionarchive.Bucket {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return filestorage.FileInfo{}, ctx.Err()
		}
	}
	return s.Storage.Put(ctx, bucket, path, body)
}

func TestArchivePreflightRejectsWhileUploadStorageIsBlocked(t *testing.T) {
	files := &blockingArchiveStorage{Storage: attachmentTestFiles(t), entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(files.release) }) }
	defer release()
	f := archiveHTTPSetupWithFiles(t, files)
	f.UseEndedTaskInput()
	f.Declare("preflight", archivePreflightCounts(), false)
	f.Declare("upload", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveReady": 1}), false)
	f.Declare("read", archiveScopeCounts(false, map[string]int{"SessionArchive": 1}), false)
	server := httptest.NewServer(f.handler.Handler)
	defer func() { release(); server.Close() }()
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	raw := jsonBody(t, doc)
	requestCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPut, server.URL+base, strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = f.backend.PlanHeader("preflight", "upload")
	req.Header.Set("Authorization", "Bearer "+f.handler.token)
	req.Header.Set("Content-Type", "application/json")
	result := make(chan error, 1)
	go func() {
		resp, e := http.DefaultClient.Do(req)
		if e == nil {
			_, e = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if e == nil && resp.StatusCode != http.StatusOK {
				e = fmt.Errorf("first upload status %d", resp.StatusCode)
			}
		}
		result <- e
	}()
	select {
	case <-files.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first upload did not reach real storage")
	}
	if f.backend.Called("SetSessionArchiveReady") != 0 {
		t.Fatal("archive receipt preceded storage completion")
	}
	authCalls := f.auth.Count()
	short, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	second, err := http.NewRequestWithContext(short, http.MethodPut, server.URL+base, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	second.Header.Set("Authorization", "Bearer "+f.handler.token)
	second.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(second)
	if err != nil {
		t.Fatalf("second upload blocked before admission: %v", err)
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil || resp.StatusCode != http.StatusTooManyRequests || !resp.Close || !bytes.Contains(body, []byte(`"resource_busy"`)) {
		t.Fatalf("second upload: %d close=%v body=%q read=%v", resp.StatusCode, resp.Close, body, err)
	}
	if f.auth.Count() != authCalls {
		t.Fatal("storage-blocked upload authenticated another request")
	}
	release()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first upload did not finish")
	}
	f.AcceptReady(t, []byte(raw))
	if response := f.Request(http.MethodGet, base+"/content", "", "preflight", "read"); response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), append(append([]byte(`{"archive":`), []byte(raw)...), '}')) {
		t.Fatalf("capacity or bytes after storage completion: %d %s", response.Code, response.Body.String())
	}
}
