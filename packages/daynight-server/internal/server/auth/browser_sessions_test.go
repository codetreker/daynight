package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func TestBrowserSessionManagementHTTP(t *testing.T) {
	const user = "11111111-1111-4111-8111-111111111111"
	const current = "22222222-2222-4222-8222-222222222222"
	const other = "33333333-3333-4333-8333-333333333333"
	p := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: current}
	stamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	session := model.Session{ID: other, UserID: user, TokenHash: []byte("private-hash"), CreatedAt: stamp, ExpiresAt: stamp.Add(time.Hour)}
	calls, touches := 0, 0
	i := &strictIdentity{t: t, callback: func() string { return "https://daynight.example/auth/callback" }}
	i.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) { return p, nil }
	i.authenticateActivity = func(context.Context, string, string) (model.Principal, error) { touches++; return p, nil }
	i.listBrowserSessions = func(_ context.Context, got model.Principal, cursor string, limit int) (identitycore.BrowserSessionPage, error) {
		calls++
		if got != p || cursor != "opaque" || limit != 3 {
			t.Errorf("list args=%+v %q %d", got, cursor, limit)
		}
		return identitycore.BrowserSessionPage{UserID: user, Current: model.Session{ID: current, CreatedAt: stamp, ExpiresAt: stamp.Add(time.Hour)}, Items: []model.Session{session}}, nil
	}
	i.getBrowserSession = func(_ context.Context, got model.Principal, id string) (model.Session, error) {
		calls++
		if got != p || id != other {
			t.Errorf("get args=%+v %q", got, id)
		}
		return session, nil
	}
	i.revokeBrowserSession = func(_ context.Context, got model.Principal, id, expectedUser, expectedSession string) error {
		calls++
		if got != p || id != other || expectedUser != user || expectedSession != current {
			t.Errorf("revoke args=%+v %q %q %q", got, id, expectedUser, expectedSession)
		}
		return nil
	}
	h, err := NewAuthentication(i, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	request := func(method, path, body, origin, auth string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://daynight.example"+path, strings.NewReader(body))
		r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "private-cookie"})
		if body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("missing no-store for %s", path)
		}
		return w
	}
	list := request("GET", "/api/v1/me/browser-sessions?limit=3&cursor=opaque", "", "", "")
	if list.Code != 200 {
		t.Fatalf("list: %d %s", list.Code, list.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(list.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["userId"] != user || body["nextCursor"] != nil || len(body["items"].([]any)) != 1 || body["current"].(map[string]any)["id"] != current || strings.Contains(list.Body.String(), "private") || len(body["items"].([]any)[0].(map[string]any)) != 6 {
		t.Fatalf("list projection: %s", list.Body.String())
	}
	read := request("GET", "/api/v1/me/browser-sessions/"+other, "", "", "")
	if read.Code != 200 || strings.Contains(read.Body.String(), "private") {
		t.Fatalf("read: %d %s", read.Code, read.Body.String())
	}
	write := request("POST", "/api/v1/me/browser-sessions/"+other+"/revoke", `{"expectedUserId":"`+user+`","expectedSessionId":"`+current+`"}`, "https://daynight.example", "")
	if write.Code != 204 || write.Body.Len() != 0 || calls != 3 {
		t.Fatalf("write: %d %s calls=%d", write.Code, write.Body.String(), calls)
	}
	for _, tc := range []struct {
		method, path, body, origin, auth string
		status                           int
	}{
		{"GET", "/api/v1/me/browser-sessions?limit=0", "", "", "", 400},
		{"GET", "/api/v1/me/browser-sessions?cursor=x&cursor=y", "", "", "", 400},
		{"GET", "/api/v1/me/browser-sessions/" + other + "?extra=1", "", "", "", 400},
		{"POST", "/api/v1/me/browser-sessions/" + other + "/revoke", `{"expectedUserId":"` + user + `","expectedSessionId":"` + current + `"}`, "https://preview.daynight.example", "", 403},
		{"POST", "/api/v1/me/browser-sessions/" + other + "/revoke", `{"expectedUserId":"` + user + `","expectedSessionId":"` + current + `"}`, "", "", 403},
		{"GET", "/api/v1/me/browser-sessions", "", "", "Bearer private", 403},
		{"POST", "/api/v1/me/browser-sessions/" + other + "/revoke", `{"expectedUserId":"` + user + `","expectedSessionId":"invalid"}`, "https://daynight.example", "", 400},
		{"POST", "/api/v1/me/browser-sessions/" + other + "/revoke", `{"expectedUserId":"` + user + `","expectedSessionId":"` + current + `","extra":1}`, "https://daynight.example", "", 400},
		{"HEAD", "/api/v1/me/browser-sessions", "", "", "", 405},
	} {
		got := request(tc.method, tc.path, tc.body, tc.origin, tc.auth)
		if got.Code != tc.status {
			t.Errorf("%s %s: got %d want %d %s", tc.method, tc.path, got.Code, tc.status, got.Body.String())
		}
	}
	if calls != 3 {
		t.Fatalf("invalid requests reached operations: %d", calls)
	}
	initialTouches := touches
	if got := request("PUT", "/api/v1/me/browser-sessions/"+other, "", "https://daynight.example", ""); got.Code != 405 || touches != initialTouches {
		t.Fatalf("method refusal status=%d renewed sessions: %d to %d", got.Code, initialTouches, touches)
	}
}

func TestBrowserSessionUnknownRevokeIsCheckedByReadingTarget(t *testing.T) {
	const user = "11111111-1111-4111-8111-111111111111"
	const current = "22222222-2222-4222-8222-222222222222"
	const target = "33333333-3333-4333-8333-333333333333"
	for _, exists := range []bool{true, false} {
		t.Run(map[bool]string{true: "still_active", false: "no_longer_active"}[exists], func(t *testing.T) {
			p := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: current}
			i := &strictIdentity{t: t, callback: func() string { return "https://daynight.example/auth/callback" }}
			i.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) { return p, nil }
			i.authenticateActivity = func(context.Context, string, string) (model.Principal, error) { return p, nil }
			writes, reads := 0, 0
			i.revokeBrowserSession = func(_ context.Context, got model.Principal, id, expectedUser, expectedSession string) error {
				writes++
				if got != p || id != target || expectedUser != user || expectedSession != current {
					t.Fatal("wrong revoke identity")
				}
				return &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("private transaction diagnostic")}
			}
			i.getBrowserSession = func(_ context.Context, got model.Principal, id string) (model.Session, error) {
				reads++
				if got != p || id != target {
					t.Fatal("wrong readback identity")
				}
				if !exists {
					return model.Session{}, &model.Fault{Code: "not_found", Message: "Browser session not found."}
				}
				return model.Session{ID: target, UserID: user, ExpiresAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)}, nil
			}
			h, err := NewAuthentication(i, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			h.RegisterRoutes(mux)
			revoke := httptest.NewRequest("POST", "https://daynight.example/api/v1/me/browser-sessions/"+target+"/revoke", strings.NewReader(`{"expectedUserId":"`+user+`","expectedSessionId":"`+current+`"}`))
			revoke.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "private-cookie"})
			revoke.Header.Set("Origin", "https://daynight.example")
			revoke.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, revoke)
			if w.Code != 503 || !strings.Contains(w.Body.String(), `"code":"write_outcome_unknown"`) || strings.Contains(w.Body.String(), "private") || w.Header().Get("Cache-Control") != "no-store" || writes != 1 {
				t.Fatalf("unknown response: %d %s writes=%d", w.Code, w.Body.String(), writes)
			}
			read := httptest.NewRequest("GET", "https://daynight.example/api/v1/me/browser-sessions/"+target, nil)
			read.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "private-cookie"})
			result := httptest.NewRecorder()
			mux.ServeHTTP(result, read)
			want := http.StatusNotFound
			if exists {
				want = http.StatusOK
			}
			if result.Code != want || writes != 1 || reads != 1 || result.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("readback status=%d writes=%d reads=%d body=%s", result.Code, writes, reads, result.Body.String())
			}
			if exists && !strings.Contains(result.Body.String(), `"id":"`+target+`"`) {
				t.Fatalf("readback target missing: %s", result.Body.String())
			}
			if !exists && !strings.Contains(result.Body.String(), `"code":"not_found"`) {
				t.Fatalf("readback not_found missing: %s", result.Body.String())
			}
		})
	}
}
