//go:build stress

package session_test

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type exactReadDeadlineObserver struct {
	http.ResponseWriter
	deadline chan time.Time
}

func (w *exactReadDeadlineObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *exactReadDeadlineObserver) SetReadDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		select {
		case w.deadline <- deadline:
		default:
		}
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func TestStressArchiveUploadDeadlineReleasesCapacity(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	if os.Getenv("DAYNIGHT_TEST_ARCHIVE_DEADLINE") != "1" {
		t.Skip("set DAYNIGHT_TEST_ARCHIVE_DEADLINE=1 to run the real 120-second deadline test")
	}
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	deadline := make(chan time.Time, 1)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		f.handler.Handler.ServeHTTP(&exactReadDeadlineObserver{ResponseWriter: w, deadline: deadline}, r)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(140 * time.Second)); err != nil {
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
	if response := busyArchiveRequest(f, http.MethodPut, base, "{}"); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), `"resource_busy"`) {
		t.Fatalf("capacity during upload: %d %s", response.Code, response.Body.String())
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusRequestTimeout || !response.Close || !strings.Contains(string(data), `"request_timeout"`) {
		t.Fatalf("timeout response: status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, data, err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed-out upload did not finish")
	}
	f.AssertReleased(t)
	assertNoArchiveBody(t, f)
	raw := nativeArchiveBody(t, f)
	if response := f.Request(http.MethodPut, base, raw, archiveUploadCalls()); response.Code != http.StatusOK {
		t.Fatalf("capacity after timeout: %d %s", response.Code, response.Body.String())
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
}

type exactWriteDeadlineObserver struct {
	http.ResponseWriter
	started  chan struct{}
	deadline chan time.Time
	once     sync.Once
}

func (w *exactWriteDeadlineObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *exactWriteDeadlineObserver) SetWriteDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		select {
		case w.deadline <- deadline:
		default:
		}
	}
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}
func (w *exactWriteDeadlineObserver) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	return w.ResponseWriter.Write(data)
}

func TestStressArchiveSendDeadlineReleasesCapacity(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are local-only")
	}
	if os.Getenv("DAYNIGHT_TEST_ARCHIVE_DEADLINE") != "1" {
		t.Skip("set DAYNIGHT_TEST_ARCHIVE_DEADLINE=1 to run the real 120-second deadline test")
	}
	f := archiveHTTPSetup(t)
	base := f.base + "/" + f.snapshot.SessionID + "/archive"
	raw := nativeArchiveBody(t, f) + strings.Repeat(" ", 16*1024*1024)
	if response := f.Request(http.MethodPut, base, raw, archiveUploadCalls()); response.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", response.Code, response.Body.String())
	}
	f.AssertBody(t, []byte(raw))
	f.AssertReleased(t)
	f.SetNativeContent([]byte(raw))
	started, done := make(chan struct{}), make(chan struct{})
	deadline := make(chan time.Time, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		f.handler.Handler.ServeHTTP(&exactWriteDeadlineObserver{ResponseWriter: w, started: started, deadline: deadline}, r)
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
	if err := conn.SetDeadline(time.Now().Add(145 * time.Second)); err != nil {
		t.Fatal(err)
	}
	f.Expect(archiveContentCalls())
	f.auth.ExpectCalls(1)
	if _, err = fmt.Fprintf(conn, "GET %s/content HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\n\r\n", base, f.handler.token); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(15 * time.Second):
		t.Fatal("archive response did not start")
	}
	select {
	case got := <-deadline:
		remaining := time.Until(got)
		if remaining < 115*time.Second || remaining > 121*time.Second {
			t.Fatalf("production send deadline: %v", remaining)
		}
	default:
		t.Fatal("archive send deadline not set")
	}
	f.AssertHeld(t)
	if response := busyArchiveRequest(f, http.MethodGet, base+"/content", ""); response.Code != http.StatusTooManyRequests || !strings.Contains(response.Body.String(), `"resource_busy"`) {
		t.Fatalf("capacity during send: %d %s", response.Code, response.Body.String())
	}
	select {
	case <-done:
	case <-time.After(130 * time.Second):
		t.Fatal("non-reading peer did not release timed-out send")
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
	if got := f.Request(http.MethodGet, base+"/content", "", archiveContentCalls()); got.Code != http.StatusOK {
		t.Fatalf("capacity after timeout: %d", got.Code)
	}
	f.AssertReleased(t)
}
