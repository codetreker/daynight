package session_test

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func TestArchiveDownloadDoesNotDrainIncompleteRequestBody(t *testing.T) {
	t.Run("v1", func(t *testing.T) {
		f := archiveHTTPSetup(t)
		base := f.base + "/" + f.snapshot.SessionID + "/archive"
		raw := nativeArchiveBody(t, f)
		f.SetNativeContent([]byte(raw))
		expected := append(append([]byte(`{"archive":`), []byte(raw)...), '}')
		before := func(content, authenticated bool) {
			calls := map[string]int{"TryReserveArchivePreflight": 1}
			if content {
				calls["ArchiveContentReserved"] = 1
			}
			f.Expect(calls)
			count := 0
			if authenticated {
				count = 1
			}
			f.auth.ExpectCalls(count)
		}
		next := func() *httptest.ResponseRecorder {
			f.AssertReleased(t)
			response := f.Request(http.MethodGet, base+"/content", "", archiveContentCalls())
			f.AssertReleased(t)
			return response
		}
		verifyUnreadArchiveDownload(t, f.handler.Handler, f.auth, f.handler.token, base+"/content", "", expected, before, next)
	})
	t.Run("v2", func(t *testing.T) {
		f, base, data, _ := terminalArchiveReady(t)
		before := func(content, authenticated bool) {
			f.calls.ExpectCalls("TryReserveArchivePreflight", f.calls.Called("TryReserveArchivePreflight")+1)
			count := 0
			if content {
				count = 1
			}
			f.calls.ExpectCalls("TerminalArchiveContentReserved", f.calls.Called("TerminalArchiveContentReserved")+count)
			count = 0
			if authenticated {
				count = 1
			}
			f.authentication.ExpectCalls(count)
		}
		next := func() *httptest.ResponseRecorder {
			before(true, true)
			return terminalRequest(f.h, http.MethodGet, base+"/content", "", v2.Protocol)
		}
		verifyUnreadArchiveDownload(t, f.h.Handler, f.authentication, f.h.token, base+"/content", v2.Protocol, data, before, next)
	})
}

func verifyUnreadArchiveDownload(t *testing.T, handler http.Handler, auth *routeAuthentication, token, path, protocol string, expected []byte, before func(bool, bool), next func() *httptest.ResponseRecorder) {
	t.Helper()
	server := httptest.NewServer(handler)
	defer server.Close()
	for _, tc := range []struct {
		name, framing, suffix string
		authorized            bool
		status                int
	}{
		{"content-length", "Content-Length: 2\r\n\r\n{", "", true, http.StatusOK},
		{"chunked", "Transfer-Encoding: chunked\r\n\r\n2\r\n{", "", true, http.StatusOK},
		{"invalid query", "Content-Length: 2\r\n\r\n{", "?invalid=1", true, http.StatusBadRequest},
		{"unauthenticated", "Content-Length: 2\r\n\r\n{", "", false, http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 3*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			authHeader := ""
			if tc.authorized {
				authHeader = "Authorization: Bearer " + token + "\r\n"
			}
			selector := ""
			if protocol != "" {
				selector = v2.ProtocolHeader + ": " + protocol + "\r\n"
			}
			before(tc.status == http.StatusOK, tc.authorized)
			authCalls := auth.Count()
			if _, err = fmt.Fprintf(conn, "GET %s%s HTTP/1.1\r\nHost: localhost\r\n%s%s%s", path, tc.suffix, authHeader, selector, tc.framing); err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("incomplete request blocked response: %v", err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != tc.status || !response.Close {
				t.Fatalf("status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, body, err)
			}
			wantAuth := authCalls
			if tc.authorized {
				wantAuth++
			}
			if auth.Count() != wantAuth {
				t.Fatalf("authentication calls=%d want %d", auth.Count(), wantAuth)
			}
			if tc.status == http.StatusOK && !bytes.Equal(body, expected) {
				t.Fatalf("archive bytes changed: got %d expected %d", len(body), len(expected))
			}
			var probe [1]byte
			_, err = conn.Read(probe[:])
			if !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
				t.Fatalf("connection remained open: %v", err)
			}
			response2 := next()
			if response2.Code != http.StatusOK || !bytes.Equal(response2.Body.Bytes(), expected) {
				t.Fatalf("capacity not released: %d %s", response2.Code, strings.TrimSpace(response2.Body.String()))
			}
		})
	}
}
