package session_test

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type sessionDeadlineObserver struct {
	http.ResponseWriter
	deadlines     []time.Time
	before        chan sessionResponseObservation
	continueWrite <-chan struct{}
	request       *http.Request
}

type sessionResponseObservation struct {
	requestError error
	deadlines    []time.Time
}

func (w *sessionDeadlineObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *sessionDeadlineObserver) SetReadDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func (w *sessionDeadlineObserver) WriteHeader(status int) {
	w.before <- sessionResponseObservation{requestError: w.request.Context().Err(), deadlines: append([]time.Time(nil), w.deadlines...)}
	<-w.continueWrite
	w.ResponseWriter.WriteHeader(status)
}

func TestSessionConsumedBodyRejectionKeepsSocketReusable(t *testing.T) {
	f := sessionHTTPSetup(t)
	archive := archiveHTTPSetup(t)
	archive.Declare("complete-body-preflight", archivePreflightCounts(), false)
	for _, tc := range []struct {
		name, method, path, headers, body, code string
		handler                                 http.Handler
		token                                   string
		status                                  int
	}{
		{"session", "POST", f.base, "Content-Type: application/json\r\n", "{}", "invalid_input", f.server.Config.Handler, f.handler.token, 400},
		{"session chunked", "POST", f.base, "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n", "2\r\n{}\r\n0\r\n\r\n", "invalid_input", f.server.Config.Handler, f.handler.token, 400},
		{"terminal", "POST", f.base, "Content-Type: application/json\r\n" + v2.ProtocolHeader + ": " + v2.Protocol + "\r\n", "{}", "invalid_payload", f.server.Config.Handler, f.handler.token, 400},
		{"archive", "PUT", archive.base + "/" + archive.snapshot.SessionID + "/archive", "Content-Type: application/json\r\n" + routePlanHeader + ": complete-body-preflight\r\n", "{}", "invalid_input", archive.handler.Handler, archive.handler.token, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testConsumedBodySocket(t, tc.handler, tc.token, tc.method, tc.path, tc.headers, tc.body, tc.code, tc.status, tc.name == "archive")
		})
	}
	terminal := terminalHTTPSetup(t)
	terminal.register(t)
	testConsumedBodySocket(t, terminal.h.Handler, terminal.h.token, "PUT", terminal.base+"/"+terminal.message.SessionID+"/archive", "Content-Type: application/json\r\n"+v2.ProtocolHeader+": "+v2.Protocol+"\r\n"+routePlanHeader+": terminal-upload-preflight\r\n", "{}", "source_corrupt", 409, true)
}

func testConsumedBodySocket(t *testing.T, handler http.Handler, token, method, path, headers, body, code string, status int, bounded bool) {
	t.Helper()
	before := make(chan sessionResponseObservation, 2)
	continueWrite := make(chan struct{}, 2)
	defer close(continueWrite)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(&sessionDeadlineObserver{ResponseWriter: w, before: before, continueWrite: continueWrite, request: r}, r)
	}))
	t.Cleanup(server.Close)
	conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	length := ""
	if !strings.Contains(headers, "Transfer-Encoding:") {
		length = fmt.Sprintf("Content-Length: %d\r\n", len(body))
	}
	_, err = fmt.Fprintf(conn, "%s %s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\n%s%s\r\n%s", method, path, token, headers, length, body)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observed := <-before:
		if observed.requestError != nil {
			t.Fatalf("complete body canceled the request: %v", observed.requestError)
		}
		if bounded {
			if len(observed.deadlines) != 2 || observed.deadlines[0].IsZero() || !observed.deadlines[1].IsZero() {
				t.Fatalf("completed archive read deadlines = %v, want a bound followed by clearing", observed.deadlines)
			}
		} else if len(observed.deadlines) != 0 {
			t.Fatalf("completed body left unexpected read deadlines: %v", observed.deadlines)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Session rejection did not reach response barrier")
	}
	continueWrite <- struct{}{}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != status || response.Close || !strings.Contains(string(data), `"code":"`+code+`"`) {
		t.Fatalf("status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, data, err)
	}
	_, err = fmt.Fprintf(conn, "GET /api/v1/session-capabilities HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n", token)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case observed := <-before:
		if observed.requestError != nil {
			t.Fatalf("keep-alive request canceled: %v", observed.requestError)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("keep-alive request did not reach response barrier")
	}
	continueWrite <- struct{}{}
	response, err = http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("keep-alive status=%d read=%v", response.StatusCode, err)
	}
}
