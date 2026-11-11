package session_test

import (
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/google/uuid"
)

func TestTestSessionListAuthenticationAndQuery(t *testing.T) {
	f := newListHTTPFixture(t)
	empty := sessioncore.TestListPage{Items: []sessioncore.TestListItem{}}
	f.Expect("", 50, false, empty, nil)
	response := f.Request(http.MethodGet, "/api/v1/test-sessions", true)
	f.Finish()
	page := decodeResponse[sessioncore.TestListPage](t, response, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatal("empty list response changed", page)
	}
	if response.Header().Get("Daynight-User-ID") != f.handler.principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("list response lost authenticated private-response headers", response.Header())
	}
	before := f.backend.TotalCalls()
	assertProjectError(t, f.Request(http.MethodGet, "/api/v1/test-sessions", false), http.StatusUnauthorized, "unauthenticated")
	if f.backend.TotalCalls() != before {
		t.Fatal("anonymous list reached the use case")
	}
	for _, query := range []string{"?unknown=1", "?limit=0", "?limit=101", "?limit=wrong", "?limit=1&limit=2", "?cursor=", "?limit=", "?online=", "?online=1", "?online=yes", "?online=TRUE", "?online=true&online=false"} {
		before := f.backend.TotalCalls()
		assertProjectError(t, f.Request(http.MethodGet, "/api/v1/test-sessions"+query, true), http.StatusBadRequest, "invalid_input")
		if f.backend.TotalCalls() != before {
			t.Fatal("invalid list query reached the use case", query)
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
		f.Expect("", selection.limit, selection.online, empty, nil)
		r := f.Request(http.MethodGet, "/api/v1/test-sessions"+selection.query, true)
		f.Finish()
		if got := decodeResponse[sessioncore.TestListPage](t, r, http.StatusOK); !reflect.DeepEqual(got, empty) {
			t.Fatal("supplied empty page changed", got)
		}
	}
	created, cursor := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC), "opaque-next-page"
	supplied := sessioncore.TestListPage{Items: []sessioncore.TestListItem{{SessionID: uuid.NewString(), Provider: "codex", Lifecycle: "active", ConnectionState: "connected", CreatedAt: created, UpdatedAt: created.Add(time.Minute)}}, NextCursor: &cursor}
	f.Expect("opaque-position", 1, true, supplied, nil)
	r := f.Request(http.MethodGet, "/api/v1/test-sessions?online=true&limit=1&cursor=opaque-position", true)
	f.Finish()
	if got := decodeResponse[sessioncore.TestListPage](t, r, http.StatusOK); !reflect.DeepEqual(got, supplied) {
		t.Fatalf("supplied list page changed: got=%+v want=%+v", got, supplied)
	}
	f.Expect("bad", 50, false, sessioncore.TestListPage{}, &model.Fault{Code: "invalid_input", Message: "Invalid test Session cursor."})
	r = f.Request(http.MethodGet, "/api/v1/test-sessions?cursor=bad", true)
	f.Finish()
	assertProjectError(t, r, http.StatusBadRequest, "invalid_input")
	f.Expect("", 50, false, sessioncore.TestListPage{}, errors.New("private list dependency failure"))
	r = f.Request(http.MethodGet, "/api/v1/test-sessions", true)
	f.Finish()
	assertProjectError(t, r, http.StatusInternalServerError, "internal_error")
	for _, method := range []string{http.MethodHead, http.MethodPatch} {
		before := f.backend.TotalCalls()
		r := f.Request(method, "/api/v1/test-sessions", true)
		if r.Code != http.StatusMethodNotAllowed || r.Header().Get("Allow") != "GET, POST" || f.backend.TotalCalls() != before {
			t.Fatal("list method handling changed", method, r.Code, r.Header())
		}
	}
	for _, failure := range []struct {
		cause  error
		status int
		code   string
	}{
		{authhttp.Failure(), http.StatusUnauthorized, "unauthenticated"},
		{errors.New("private authentication dependency failure"), http.StatusInternalServerError, "internal_error"},
	} {
		f.auth.RejectCredential(f.handler.token, failure.cause)
		before := f.backend.TotalCalls()
		assertProjectError(t, f.Request(http.MethodGet, "/api/v1/test-sessions", true), failure.status, failure.code)
		if f.backend.TotalCalls() != before {
			t.Fatal("authentication failure reached the list use case")
		}
	}
}

func TestTestSessionListCallbackPathIsReserved(t *testing.T) {
	config := authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}
	for _, path := range []string{"/test-sessions", "/test-sessions/one", "/api/v1/test-sessions", "/api/v1/test-sessions/one"} {
		if _, _, err := authconfig.ValidateAuthSettings(config, config.PublicOrigin+path); err == nil {
			t.Fatal("callback overlaps session route", path)
		}
	}
	if _, _, err := authconfig.ValidateAuthSettings(config, config.PublicOrigin+"/test-sessions-callback"); err != nil {
		t.Fatal("independent callback refused", err)
	}
}
