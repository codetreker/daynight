package session

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
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type archiveFailingBody struct{ readErr, closeErr error }

func (b archiveFailingBody) Read([]byte) (int, error) { return 0, b.readErr }
func (b archiveFailingBody) Close() error             { return b.closeErr }

func TestArchiveBodyPreservesIndependentCloseFailure(t *testing.T) {
	readErr, closeErr := errors.New("read failed"), errors.New("close failed")
	r := httptest.NewRequest(http.MethodPut, "/archive", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = archiveFailingBody{readErr: readErr, closeErr: closeErr}
	_, err := archiveBody(httptest.NewRecorder(), r)
	if !errors.Is(err, readErr) || !errors.Is(err, closeErr) {
		t.Fatalf("lost error causes: %v", err)
	}
	if fault, ok := httpx.KnownFault(err); !ok || fault.Code != "cleanup_unknown" {
		t.Fatalf("cleanup failure disguised as a read rejection: %v", err)
	}
}

func TestArchiveCleanupFailureDoesNotMasqueradeAsRejection(t *testing.T) {
	cause := &model.Fault{Code: "source_corrupt", Message: "Invalid archive."}
	closeErr := errors.New("permit close failed")
	err := archiveCleanupError(cause, closeErr)
	if !errors.Is(err, cause) || !errors.Is(err, closeErr) {
		t.Fatalf("lost error causes: %v", err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodPut, "/archive", nil)
	httpx.WriteError(w, r, testLogger(), "session", "archive", err)
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), `"cleanup_unknown"`) {
		t.Fatalf("cleanup failure disguised as rejection: %d %s", w.Code, w.Body.String())
	}
}

func TestArchiveIndependentCloseTimeoutIsNotReadTimeout(t *testing.T) {
	r := httptest.NewRequest(http.MethodPut, "/archive", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = archiveFailingBody{readErr: &net.OpError{Op: "read", Net: "tcp", Err: os.ErrDeadlineExceeded}, closeErr: os.ErrDeadlineExceeded}
	_, err := archiveBodyWithTimeout(httptest.NewRecorder(), r, time.Second)
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("lost timeout causes: %v", err)
	}
	if fault, ok := httpx.KnownFault(err); !ok || fault.Code != "cleanup_unknown" {
		t.Fatalf("independent close failure disguised as read timeout: %v", err)
	}
}

func TestArchiveIndependentMatchingTimeoutsAreNotOneSocketFailure(t *testing.T) {
	source := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1234}
	destination := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 4321}
	readErr := &net.OpError{Op: "read", Net: "tcp", Source: source, Addr: destination, Err: os.ErrDeadlineExceeded}
	closeErr := &net.OpError{Op: "read", Net: "tcp", Source: source, Addr: destination, Err: os.ErrDeadlineExceeded}
	r := httptest.NewRequest(http.MethodPut, "/archive", nil)
	r.Header.Set("Content-Type", "application/json")
	r.Body = archiveFailingBody{readErr: readErr, closeErr: closeErr}
	var err error
	httpx.RequestLogging(testLogger(), http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_, err = archiveBodyWithTimeout(w, request, time.Second)
	})).ServeHTTP(httptest.NewRecorder(), r)
	if !errors.Is(err, readErr) || !errors.Is(err, closeErr) {
		t.Fatalf("lost error causes: %v", err)
	}
	if fault, ok := httpx.KnownFault(err); !ok || fault.Code != "cleanup_unknown" {
		t.Fatalf("independent close failure disguised as read timeout: %v", err)
	}
}

func TestArchiveBodyDeadlineInterruptsSocket(t *testing.T) {
	if transport.ArchiveBodyReadTimeout != 120*time.Second {
		t.Fatal("archive upload deadline changed")
	}
	for _, expectContinue := range []bool{false, true} {
		t.Run(fmt.Sprintf("expect-continue-%t", expectContinue), func(t *testing.T) {
			testArchiveBodyDeadlineSocket(t, expectContinue)
		})
	}
}

func testArchiveBodyDeadlineSocket(t *testing.T, expectContinue bool) {
	t.Helper()
	done := make(chan struct{})
	errs := make(chan error, 1)
	server := httptest.NewServer(httpx.RequestLogging(testLogger(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		_, err := archiveBodyWithTimeout(w, r, 200*time.Millisecond)
		errs <- err
		if err != nil {
			httpx.WriteBodyError(w, r, testLogger(), "session", "archive", err)
		}
	})))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	expect := ""
	if expectContinue {
		expect = "Expect: 100-continue\r\n"
	}
	if _, err = fmt.Fprintf(conn, "PUT /archive HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 2\r\n%s\r\n{", expect); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	if expectContinue {
		response, err := http.ReadResponse(reader, nil)
		if err != nil || response.StatusCode != http.StatusContinue {
			t.Fatalf("100-continue: %v %v", response, err)
		}
	}
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusRequestTimeout || !response.Close || !strings.Contains(string(body), `"request_timeout"`) {
		t.Fatalf("status=%d close=%v body=%q read=%v operation=%#v", response.StatusCode, response.Close, body, err, <-errs)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("read deadline did not interrupt the handler")
	}
}
