package preview

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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// These requests deliberately leave their declared bodies unsent. An actual
// HTTP/1 server otherwise waits while draining them before writing the response.
func TestPreviewRejectsUnreadBodiesWithoutBlockingSocket(t *testing.T) {
	ops := &operations{
		create: func(context.Context, string) (model.PreviewSSOLogin, error) {
			return model.PreviewSSOLogin{ID: "record"}, nil
		},
		start: func(_ context.Context, id string) (identity.PreviewSSOStart, error) {
			return identity.PreviewSSOStart{LoginID: id, State: secret.Random(""), ExpiresAt: time.Now().Add(time.Minute)}, nil
		},
		authenticate: func(context.Context, string) (model.Principal, time.Time, error) {
			return model.Principal{UserID: "user"}, time.Time{}, nil
		},
	}
	h, handler := taskFixture(t, ops, func(w http.ResponseWriter, _ *http.Request, _ model.Principal) { _, _ = w.Write([]byte("ok")) })
	server := httptest.NewServer(httpx.RequestLogging(h.logger, handler))
	t.Cleanup(server.Close)
	for _, tc := range []struct {
		name, method, host, path, headers string
		status                            int
	}{
		{"document redirect", "GET", taskID + ".preview.daynight.test", taskPath, "Sec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: iframe\r\n", 303},
		{"document refusal", "GET", taskID + ".preview.daynight.test", strings.Replace(taskPath, taskID, "1624a880-b44b-41fd-9ac7-f6486b09386d", 1), "Sec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: iframe\r\n", 404},
		{"unauthenticated subresource", "GET", taskID + ".preview.daynight.test", taskPath, "", 401},
		{"head refusal", "HEAD", taskID + ".preview.daynight.test", taskPath, "", 401},
		{"authenticated content", "GET", taskID + ".preview.daynight.test", taskPath, "Cookie: " + h.SessionCookieName() + "=valid\r\n", 200},
		{"unknown route", "GET", taskID + ".preview.daynight.test", "/unknown", "", 404},
		{"invalid preview host", "GET", "bad.preview.daynight.test", "/unknown", "", 404},
		{"bare preview host", "GET", "preview.daynight.test", "/unknown", "", 404},
		{"bare SSO redirect", "GET", "preview.daynight.test", StartPath + "?login=record", "", 303},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 3*time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fprintf(conn, "%s %s HTTP/1.1\r\nHost: %s\r\n%sContent-Length: 100\r\n\r\n", tc.method, tc.path, tc.host, tc.headers); err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), &http.Request{Method: tc.method})
			if err != nil {
				t.Fatalf("response did not arrive without the request body: %v", err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != tc.status || !response.Close || tc.method == "HEAD" && len(body) != 0 {
				t.Fatalf("response status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, body, err)
			}
		})
	}
}
