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

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func TestArchiveDownloadDoesNotDrainIncompleteRequestBody(t *testing.T) {
	t.Run("v1", func(t *testing.T) {
		f := archiveHTTPSetup(t)
		base := f.base + "/" + f.snapshot.SessionID + "/archive"
		f.UseEndedTaskInput()
		f.Declare("preflight", archivePreflightCounts(), false)
		f.Declare("upload", archiveScopeCounts(true, map[string]int{"SessionArchive": 1, "SetSessionArchiveReady": 1}), false)
		f.Declare("read", archiveScopeCounts(false, map[string]int{"SessionArchive": 1}), false)
		doc := sp.ArchiveDocument{Fence: f.snapshot.Fence, SchemaVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
		raw := jsonBody(t, doc)
		if response := f.Request(http.MethodPut, base, raw, "preflight", "upload"); response.Code != http.StatusOK {
			t.Fatalf("upload: %d %s", response.Code, response.Body.String())
		}
		f.AcceptReady(t, []byte(raw))
		expected := append(append([]byte(`{"archive":`), []byte(raw)...), '}')
		verifyUnreadArchiveDownload(t, f.handler.Handler, f.auth, f.handler.token, base+"/content", "", expected, []string{"preflight", "read"}, func() *httptest.ResponseRecorder {
			return f.Request(http.MethodGet, base+"/content", "", "preflight", "read")
		})
	})
	t.Run("v2", func(t *testing.T) {
		f, base, data, _ := terminalArchiveReady(t)
		f.declareTerminal("unread-preflight", map[string]int{"ReadCredential": 1, "ProjectAccess": 1, "ArchiveMetadata": 1}, false)
		f.declareTerminal("unread-content", terminalReadCounts(map[string]int{"TerminalArchive": 1}), false)
		verifyUnreadArchiveDownload(t, f.h.Handler, f.h.authentication, f.h.token, base+"/content", v2.Protocol, data, []string{"unread-preflight", "unread-content"}, func() *httptest.ResponseRecorder {
			return terminalRequest(f.h, http.MethodGet, base+"/content", "", v2.Protocol, "unread-preflight", "unread-content")
		})
	})
}

func verifyUnreadArchiveDownload(t *testing.T, handler http.Handler, auth *routeAuthentication, token, path, protocol string, expected []byte, plans []string, next func() *httptest.ResponseRecorder) {
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
			plan := ""
			if tc.status == http.StatusOK {
				plan = routePlanHeader + ": " + strings.Join(plans, ",") + "\r\n"
			}
			authCalls := auth.Count()
			if _, err = fmt.Fprintf(conn, "GET %s%s HTTP/1.1\r\nHost: localhost\r\n%s%s%s%s", path, tc.suffix, authHeader, selector, plan, tc.framing); err != nil {
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
