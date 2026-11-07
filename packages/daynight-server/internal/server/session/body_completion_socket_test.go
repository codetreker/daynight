package session_test

import (
	"bufio"
	"context"
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
	deadline      chan time.Time
	before        chan error
	continueWrite <-chan struct{}
	request       *http.Request
}

func (w *sessionDeadlineObserver) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *sessionDeadlineObserver) SetReadDeadline(deadline time.Time) error {
	w.deadline <- deadline
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func (w *sessionDeadlineObserver) WriteHeader(status int) {
	w.before <- w.request.Context().Err()
	<-w.continueWrite
	w.ResponseWriter.WriteHeader(status)
}

func TestSessionConsumedBodyRejectionKeepsSocketReusable(t *testing.T) {
	f := sessionHTTPSetup(t)
	_, err := f.db.Pool.Exec(context.Background(), `CREATE FUNCTION reject_attachment_metadata() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected metadata failure'; END $$; CREATE TRIGGER reject_attachment_metadata BEFORE INSERT ON task_attachments FOR EACH ROW EXECUTE FUNCTION reject_attachment_metadata()`)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, method, path, headers, body, code string
		status                                  int
	}{
		{"session", "POST", f.base, "Content-Type: application/json\r\n", "{}", "invalid_input", 400},
		{"session chunked", "POST", f.base, "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n", "2\r\n{}\r\n0\r\n\r\n", "invalid_input", 400},
		{"terminal", "POST", f.base, "Content-Type: application/json\r\n" + v2.ProtocolHeader + ": " + v2.Protocol + "\r\n", "{}", "invalid_payload", 400},
		{"archive", "PUT", f.base + "/" + f.snapshot.SessionID + "/archive", "Content-Type: application/json\r\n", "{}", "invalid_input", 400},
		{"attachment metadata", "PUT", attachmentFilePath(f.task, "metadata-failure"), "Content-Type: text/plain\r\n", "abc", "internal_error", 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testConsumedBodySocket(t, f.server.Config.Handler, f.handler.token, tc.method, tc.path, tc.headers, tc.body, tc.code, tc.status, tc.name == "attachment metadata" || tc.name == "archive")
		})
	}
	terminal := terminalHTTPSetup(t)
	terminalMessage(t, terminalRequest(terminal.h, http.MethodPost, terminal.base, jsonBody(t, terminal.message), v2.Protocol))
	testConsumedBodySocket(t, terminal.h.Handler, terminal.h.token, "PUT", terminal.base+"/"+terminal.message.SessionID+"/archive", "Content-Type: application/json\r\n"+v2.ProtocolHeader+": "+v2.Protocol+"\r\n", "{}", "source_corrupt", 409, true)
}

func testConsumedBodySocket(t *testing.T, handler http.Handler, token, method, path, headers, body, code string, status int, bounded bool) {
	t.Helper()
	deadline := make(chan time.Time, 2)
	before := make(chan error, 2)
	continueWrite := make(chan struct{}, 2)
	defer close(continueWrite)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(&sessionDeadlineObserver{ResponseWriter: w, deadline: deadline, before: before, continueWrite: continueWrite, request: r}, r)
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
	case err := <-before:
		if err != nil {
			t.Fatalf("complete body canceled the request: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Session rejection did not reach response barrier")
	}
	if bounded {
		select {
		case got := <-deadline:
			if got.IsZero() {
				t.Fatal("attachment read deadline was not set")
			}
		default:
			t.Fatal("attachment read deadline was not observed")
		}
		select {
		case got := <-deadline:
			if !got.IsZero() {
				t.Fatalf("attachment read deadline not cleared: %v", got)
			}
		default:
			t.Fatal("attachment read deadline clear was not observed")
		}
	}
	select {
	case got := <-deadline:
		t.Fatalf("completed body left an unexpected read deadline: %v", got)
	default:
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
	case err := <-before:
		if err != nil {
			t.Fatalf("keep-alive request canceled: %v", err)
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
