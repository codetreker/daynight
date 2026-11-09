package session_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTestSessionListAuthenticationAndQuery(t *testing.T) {
	f := newListHTTPFixture(t)
	request := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		before := f.auth.Count()
		response := projectRequest(f.handler, method, path, "")
		if f.auth.Count() != before+1 {
			t.Fatal("list route did not authenticate exactly once")
		}
		return response
	}
	f.writer.Expect(50, false, []store.TestSessionListItem{})
	response := request(http.MethodGet, "/api/v1/test-sessions")
	f.writer.Finish()
	page := decodeResponse[sessioncore.TestListPage](t, response, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatal("empty owner list", page)
	}
	anonymous := httptest.NewRecorder()
	authCalls, writerCalls := f.auth.Count(), f.writer.calls
	f.handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/v1/test-sessions", nil))
	if anonymous.Code != http.StatusUnauthorized || f.auth.Count() != authCalls || f.writer.calls != writerCalls {
		t.Fatal("anonymous list", anonymous.Code)
	}
	for _, query := range []string{"?unknown=1", "?limit=0", "?limit=101", "?limit=wrong", "?limit=1&limit=2", "?cursor=bad", "?cursor=", "?limit=", "?online=", "?online=1", "?online=yes", "?online=TRUE", "?online=true&online=false"} {
		before := f.writer.calls
		if r := request(http.MethodGet, "/api/v1/test-sessions"+query); r.Code != http.StatusBadRequest || f.writer.calls != before {
			t.Fatal(query, r.Code, r.Body.String())
		}
	}
	for _, selection := range []struct {
		query  string
		limit  int
		online bool
	}{
		{"?online=true", 50, true},
		{"?online=false", 50, false},
		{"?online=true&limit=1", 1, true},
	} {
		f.writer.Expect(selection.limit, selection.online, []store.TestSessionListItem{})
		r := request(http.MethodGet, "/api/v1/test-sessions"+selection.query)
		f.writer.Finish()
		if r.Code != http.StatusOK {
			t.Fatal(selection.query, r.Code, r.Body.String())
		}
	}
	seen := time.Now()
	created := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	id := uuid.NewString()
	f.writer.Expect(1, true, []store.TestSessionListItem{{Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, Identity: sp.Identity{Provider: "codex"}, Lifecycle: "active", ConnectionState: "disconnected"}, LastSeen: &seen, CreatedAt: created, UpdatedAt: created.Add(time.Minute)}})
	r := request(http.MethodGet, "/api/v1/test-sessions?online=true&limit=1")
	f.writer.Finish()
	listed := decodeResponse[sessioncore.TestListPage](t, r, http.StatusOK)
	if len(listed.Items) != 1 || listed.NextCursor != nil || listed.Items[0].SessionID != id || listed.Items[0].Provider != "codex" || listed.Items[0].Lifecycle != "active" || listed.Items[0].ConnectionState != "connected" || listed.Items[0].CreatedAt != created || listed.Items[0].UpdatedAt != created.Add(time.Minute) {
		t.Fatalf("supplied online list DTO was not encoded: %+v", listed)
	}
	for _, method := range []string{http.MethodHead, http.MethodPatch} {
		before := f.writer.calls
		r := request(method, "/api/v1/test-sessions")
		if r.Code != http.StatusMethodNotAllowed || r.Header().Get("Allow") != "GET, POST" || f.writer.calls != before {
			t.Fatal("method", method, r.Code, r.Header())
		}
	}
}

func TestTestSessionListCallbackPathIsReserved(t *testing.T) {
	config := configpkg.AuthSettings{PublicOrigin: "https://daynight.example.com"}
	for _, path := range []string{"/test-sessions", "/test-sessions/one", "/api/v1/test-sessions", "/api/v1/test-sessions/one"} {
		if _, _, err := configpkg.ValidateAuthSettings(config, config.PublicOrigin+path); err == nil {
			t.Fatal("callback overlaps session route", path)
		}
	}
	if _, _, err := configpkg.ValidateAuthSettings(config, config.PublicOrigin+"/test-sessions-callback"); err != nil {
		t.Fatal("independent callback refused", err)
	}
}
