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
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	// Whitespace is valid archive input and must remain byte-for-byte intact.
	raw := nativeArchiveBody(t, f) + strings.Repeat(" ", 16*1024*1024)
	if response := f.Request(http.MethodPut, base, raw, archiveUploadCalls()); response.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
	f.SetNativeContent([]byte(raw))
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
	f.Expect(archiveContentCalls())
	f.auth.ExpectCalls(1)
	if _, err = fmt.Fprintf(conn, "GET %s/content HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\n\r\n", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("archive response did not start")
	}
	f.AssertHeld(t)
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
	if response := busyArchiveRequest(f, http.MethodGet, base+"/content", ""); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), `"resource_busy"`) {
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
	f.AssertReleased(t)
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
	got := f.Request(http.MethodGet, base+"/content", "", archiveContentCalls())
	if got.Code != http.StatusOK || !bytes.Equal(got.Body.Bytes(), append(append([]byte(`{"archive":`), []byte(raw)...), '}')) {
		t.Fatalf("capacity or raw bytes after failure: status %d, length %d", got.Code, got.Body.Len())
	}
	f.AssertReleased(t)
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
	f.Expect(archiveUploadCalls())
	f.auth.ExpectCalls(1)
	if _, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{", base, f.handler.token); err != nil {
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
	f.AssertHeld(t)
	authCalls := f.auth.Count()
	if response := busyArchiveRequest(f, http.MethodPut, base, "{}"); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), `"resource_busy"`) {
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
	f.AssertReleased(t)
	assertNoArchiveBody(t, f)
	raw := nativeArchiveBody(t, f)
	if response := f.Request(http.MethodPut, base, raw, archiveUploadCalls()); response.Code != http.StatusOK {
		t.Fatalf("capacity after disconnect: %d %s", response.Code, response.Body.String())
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
}

func TestArchivePreflightRejectsBeforeAuthenticationWhileBodyIsUnread(t *testing.T) {
	f := archiveHTTPSetup(t)
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
	f.Expect(archiveUploadCalls())
	f.auth.ExpectCalls(1)
	if _, err = fmt.Fprintf(conn, "PUT %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 2\r\nX-Test-Stall: 1\r\n\r\n{", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	select {
	case <-deadline:
	case <-time.After(5 * time.Second):
		t.Fatal("first upload was not admitted")
	}
	f.AssertHeld(t)
	authCalls := f.auth.Count()
	for _, tc := range []struct{ method, path, protocol string }{
		{http.MethodPut, base, ""}, {http.MethodGet, base + "/content", ""},
		{http.MethodPut, base, v2.Protocol}, {http.MethodGet, base + "/content", v2.Protocol},
		{http.MethodPut, "/api/v1/test-sessions/" + f.snapshot.SessionID + "/archive", ""},
		{http.MethodGet, "/api/v1/test-sessions/" + f.snapshot.SessionID + "/archive/content", ""},
	} {
		f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
		f.auth.ExpectCalls(0)
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
	f.AssertReleased(t)
	assertNoArchiveBody(t, f)
	raw := nativeArchiveBody(t, f)
	if response := f.Request(http.MethodPut, base, raw, archiveUploadCalls()); response.Code != http.StatusOK {
		t.Fatalf("capacity after drain: %d %s", response.Code, response.Body.String())
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
	f.SetNativeContent([]byte(raw))
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

type archiveSocketReadDeadlineTrace struct {
	http.ResponseWriter
	mu        sync.Mutex
	deadlines []time.Time
}

func (w *archiveSocketReadDeadlineTrace) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *archiveSocketReadDeadlineTrace) SetReadDeadline(deadline time.Time) error {
	w.mu.Lock()
	w.deadlines = append(w.deadlines, deadline)
	w.mu.Unlock()
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}
func (w *archiveSocketReadDeadlineTrace) AssertCleared(t *testing.T) {
	t.Helper()
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.deadlines) < 2 || w.deadlines[0].IsZero() || !w.deadlines[len(w.deadlines)-1].IsZero() {
		t.Fatal("archive upload did not clear its body read deadline before calling the usecase")
	}
}

func TestArchivePreflightRejectsWhileUploadUseCaseIsBlocked(t *testing.T) {
	f := archiveHTTPSetup(t)
	entered, releaseChannel := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(releaseChannel) }) }
	defer release()
	f.BeforePut = func(ctx context.Context, body []byte) error {
		if err := ctx.Err(); err != nil {
			t.Error("completed body canceled the usecase context", err)
			return err
		}
		close(entered)
		select {
		case <-releaseChannel:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	traces := make(chan *archiveSocketReadDeadlineTrace, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Block") == "1" {
			trace := &archiveSocketReadDeadlineTrace{ResponseWriter: w}
			traces <- trace
			w = trace
		}
		f.handler.Handler.ServeHTTP(w, r)
	}))
	defer func() { release(); server.Close() }()
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	raw := nativeArchiveBody(t, f)
	requestCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPut, server.URL+base, strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+f.handler.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Test-Block", "1")
	f.Expect(archiveUploadCalls())
	f.auth.ExpectCalls(1)
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
	case <-entered:
	case err := <-result:
		t.Fatal("upload did not enter the direct usecase", err)
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not enter the direct usecase")
	}
	var trace *archiveSocketReadDeadlineTrace
	select {
	case trace = <-traces:
	case <-time.After(5 * time.Second):
		t.Fatal("upload did not expose its socket read deadline trace")
	}
	trace.AssertCleared(t)
	f.AssertHeld(t)
	authCalls := f.auth.Count()
	short, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	second, err := http.NewRequestWithContext(short, http.MethodPut, server.URL+base, strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	second.Header.Set("Authorization", "Bearer "+f.handler.token)
	second.Header.Set("Content-Type", "application/json")
	f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
	f.auth.ExpectCalls(0)
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
		t.Fatal("blocked upload authenticated another request")
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
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
	f.SetNativeContent([]byte(raw))
	if response := f.Request(http.MethodGet, base+"/content", "", archiveContentCalls()); response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), append(append([]byte(`{"archive":`), []byte(raw)...), '}')) {
		t.Fatalf("capacity or bytes after usecase completion: %d %s", response.Code, response.Body.String())
	}
	f.AssertReleased(t)
}

func archiveUploadCalls() map[string]int {
	return map[string]int{"TryReserveArchivePreflight": 1, "BeginArchiveReserved": 1}
}
func archiveContentCalls() map[string]int {
	return map[string]int{"TryReserveArchivePreflight": 1, "ArchiveContentReserved": 1}
}
func busyArchiveRequest(f *archiveHTTPFixture, method, path, body string) *httptest.ResponseRecorder {
	f.Expect(map[string]int{"TryReserveArchivePreflight": 1})
	f.auth.ExpectCalls(0)
	return projectRequest(f.handler, method, path, body)
}
func nativeArchiveBody(t *testing.T, f *archiveHTTPFixture) string {
	t.Helper()
	return jsonBody(t, sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}})
}
func assertNoArchiveBody(t *testing.T, f *archiveHTTPFixture) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.rawBodies) != 0 {
		t.Fatal("an incomplete archive body reached the usecase")
	}
}
