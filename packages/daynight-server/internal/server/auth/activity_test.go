package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func TestBrowserActivityBindingRejectsMissingVerifier(t *testing.T) {
	h := &RequestAuthentication{}
	defer func() {
		if recover() == nil {
			t.Error("browser activity binding accepted a missing verifier")
		}
	}()
	h.BindBrowserActivity(nil)
}

func TestBrowserActivityEntryAdmission(t *testing.T) {
	for _, tc := range []struct {
		name, method, pattern, origin, host, site, mode, dest, user string
		active                                                      bool
	}{
		{name: "same_origin_fetch", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "cors", dest: "empty", active: true},
		{name: "same_origin_navigation", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "navigate", dest: "iframe", user: "?1", active: true},
		{name: "same_origin_mode", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "same-origin", dest: "empty", active: true},
		{name: "same_origin_no_cors_fetch", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "no-cors", dest: "empty", active: true},
		{name: "same_origin_image_resource", method: "GET", pattern: "GET /api/v1/me/avatar", site: "same-origin", mode: "no-cors", dest: "image", active: true},
		{name: "invalid_no_cors_destination", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "no-cors", dest: "banana"},
		{name: "websocket", method: "GET", pattern: "GET /api/v1/me", origin: "https://daynight.test", site: "same-origin", mode: "websocket", dest: "empty", active: true},
		{name: "unknown_mode", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "unexpected", dest: "empty"},
		{name: "origin_only", method: "GET", pattern: "GET /api/v1/me", origin: "https://daynight.test", active: true},
		{name: "implied_head", method: "HEAD", pattern: "GET /api/v1/me", origin: "https://daynight.test", active: true},
		{name: "explicit_head_refusal", method: "HEAD", pattern: "HEAD /api/v1/me", origin: "https://daynight.test"},
		{name: "method_fallback", method: "DELETE", pattern: "/api/v1/me", origin: "https://daynight.test"},
		{name: "server_poll", method: "GET", pattern: "GET /api/v1/me"},
		{name: "cross_site_automatic", method: "GET", pattern: "GET /api/v1/me", site: "cross-site", mode: "no-cors", dest: "image"},
		{name: "preview_same_site", method: "GET", pattern: "GET /api/v1/me", site: "same-site", mode: "cors", dest: "empty"},
		{name: "origin_contradiction", method: "GET", pattern: "GET /api/v1/me", origin: "https://preview.daynight.test", site: "same-origin", mode: "cors", dest: "empty"},
		{name: "fetch_contradiction", method: "GET", pattern: "GET /api/v1/me", origin: "https://daynight.test", site: "cross-site", mode: "cors", dest: "empty"},
		{name: "cors_image", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "cors", dest: "image", active: true},
		{name: "same_origin_worker", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "same-origin", dest: "worker", active: true},
		{name: "invalid_mode_dest", method: "GET", pattern: "GET /api/v1/me", site: "same-origin", mode: "cors", dest: "document"},
		{name: "incomplete_metadata", method: "GET", pattern: "GET /api/v1/me", site: "same-origin"},
		{name: "public_path", method: "GET", pattern: "GET /public", origin: "https://daynight.test"},
		{name: "forged_authority", method: "GET", pattern: "GET /api/v1/me", origin: "https://daynight.test", host: "evil.test"},
		{name: "logout", method: "POST", pattern: "POST /api/v1/auth/logout", origin: "https://daynight.test"},
		{name: "preview_sso", method: "GET", pattern: "GET /api/v1/auth/preview/authorize", origin: "https://daynight.test"},
		{name: "login_intermediate", method: "GET", pattern: "GET /api/v1/auth/login", origin: "https://daynight.test"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			principal := model.Principal{Kind: model.SessionCredential, UserID: "account", CredentialID: "session"}
			reads, touches := 0, 0
			h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
				reads++
				return principal, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, slog.Default())
			if err != nil {
				t.Fatal(err)
			}
			h.BindBrowserActivity(func(_ context.Context, value, expected string) (model.Principal, error) {
				touches++
				if value != "original-secret" || expected != "" {
					t.Fatal("activity credential changed")
				}
				return principal, nil
			})
			mux := http.NewServeMux()
			mux.HandleFunc(tc.pattern, h.Require(func(w http.ResponseWriter, _ *http.Request, p model.Principal) {
				if p != principal {
					t.Fatal("principal changed")
				}
				w.WriteHeader(http.StatusNotModified)
			}))
			r := httptest.NewRequest(tc.method, "https://daynight.test/api/v1/me", nil)
			_, path, _ := strings.Cut(tc.pattern, " ")
			if path == "" {
				path = tc.pattern
			}
			r.URL.Path = path
			if tc.host != "" {
				r.Host = tc.host
			}
			r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "original-secret"})
			for key, value := range map[string]string{"Origin": tc.origin, "Sec-Fetch-Site": tc.site, "Sec-Fetch-Mode": tc.mode, "Sec-Fetch-Dest": tc.dest, "Sec-Fetch-User": tc.user} {
				if value != "" {
					r.Header.Set(key, value)
				}
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != http.StatusNotModified || len(w.Result().Cookies()) != 0 || touches != map[bool]int{true: 1, false: 0}[tc.active] || reads+touches != 1 {
				t.Fatalf("status=%d reads=%d touches=%d cookies=%v", w.Code, reads, touches, w.Result().Cookies())
			}
		})
	}
}

func TestSessionActivityProtocolBeforeWrite(t *testing.T) {
	account := "10000000-0000-4000-8000-000000000001"
	for _, tc := range []struct {
		name, method, origin, body, authorization, query string
		duplicateOrigin                                  bool
		status, calls                                    int
	}{
		{name: "success", method: "POST", origin: "https://daynight.test", body: `{"expectedUserId":"` + account + `"}`, status: 204, calls: 1},
		{name: "wrong_account", method: "POST", origin: "https://daynight.test", body: `{"expectedUserId":"20000000-0000-4000-8000-000000000001"}`, status: 409, calls: 1},
		{name: "missing_origin", method: "POST", body: `{"expectedUserId":"` + account + `"}`, status: 403},
		{name: "preview_origin", method: "POST", origin: "https://preview.daynight.test", body: `{"expectedUserId":"` + account + `"}`, status: 403},
		{name: "duplicate_origin", method: "POST", origin: "https://daynight.test", duplicateOrigin: true, body: `{"expectedUserId":"` + account + `"}`, status: 403},
		{name: "bearer", method: "POST", origin: "https://daynight.test", authorization: "Bearer secret", body: `{"expectedUserId":"` + account + `"}`, status: 403},
		{name: "invalid_account", method: "POST", origin: "https://daynight.test", body: `{"expectedUserId":"invalid"}`, status: 400},
		{name: "missing_account", method: "POST", origin: "https://daynight.test", body: `{}`, status: 400},
		{name: "extra_field", method: "POST", origin: "https://daynight.test", body: `{"expectedUserId":"` + account + `","extra":true}`, status: 400},
		{name: "query", method: "POST", origin: "https://daynight.test", query: "?extra=1", body: `{"expectedUserId":"` + account + `"}`, status: 400},
		{name: "head", method: "HEAD", origin: "https://daynight.test", status: 405},
		{name: "get", method: "GET", origin: "https://daynight.test", status: 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			i := &strictIdentity{t: t, callback: func() string { return "https://daynight.test/auth/callback" }, authenticateActivity: func(ctx context.Context, value, expected string) (model.Principal, error) {
				calls++
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 15*time.Second || value != "original-secret" {
					t.Fatal("activity lost credential or deadline")
				}
				if expected != account {
					return model.Principal{}, &model.Fault{Code: "identity_mismatch", Message: "The browser account changed."}
				}
				return model.Principal{Kind: model.SessionCredential, UserID: account, CredentialID: "session"}, nil
			}}
			h, err := NewAuthentication(i, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, slog.Default())
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			h.RegisterRoutes(mux)
			r := httptest.NewRequest(tc.method, "https://daynight.test/api/v1/auth/session/activity"+tc.query, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if tc.duplicateOrigin {
				r.Header.Add("Origin", tc.origin)
			}
			if tc.authorization != "" {
				r.Header.Set("Authorization", tc.authorization)
			}
			r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "original-secret"})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status || calls != tc.calls || len(w.Result().Cookies()) != 0 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d calls=%d cookies=%v", w.Code, calls, w.Result().Cookies())
			}
			if tc.status == 204 && w.Header().Get("Daynight-User-ID") != account {
				t.Fatal("success lost account identity")
			}
		})
	}
}

func TestBrowserActivityPreservesVerifierFailure(t *testing.T) {
	cause := errors.New("activity commit unavailable")
	h, _ := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		t.Fatal("activity used read verifier")
		return model.Principal{}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, slog.Default())
	h.BindBrowserActivity(func(context.Context, string, string) (model.Principal, error) { return model.Principal{}, cause })
	r := httptest.NewRequest("GET", "https://daynight.test/api/v1/me", nil)
	r.Pattern = "GET /api/v1/me"
	r.Header.Set("Origin", h.Origin())
	r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "original"})
	if _, err := h.AuthenticateRequest(r); err != cause {
		t.Fatalf("error=%v", err)
	}
}

func TestBrowserSessionEntryRenewsOnlyAdmittedActivity(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: "account", CredentialID: "session"}
	reads, touches := 0, 0
	h, _ := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		reads++
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, slog.Default())
	h.BindBrowserActivity(func(context.Context, string, string) (model.Principal, error) { touches++; return principal, nil })
	r := httptest.NewRequest("GET", "https://daynight.test/api/v2/me/tokens", nil)
	r.Pattern = "GET /api/v2/me/tokens"
	r.Header.Set("Origin", h.Origin())
	r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "original"})
	if got, err := h.AuthenticateSessionRequest(r); err != nil || got != principal || touches != 1 || reads != 0 {
		t.Fatalf("activity principal=%+v error=%v reads=%d touches=%d", got, err, reads, touches)
	}
	r.Pattern = "/api/v1/auth/preview/authorize"
	if _, err := h.AuthenticateSessionRequest(r); err != nil || reads != 1 || touches != 1 {
		t.Fatalf("navigation error=%v reads=%d touches=%d", err, reads, touches)
	}
}

func TestMainActivityRejectsDuplicateSourceMetadata(t *testing.T) {
	h, _ := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		t.Fatal("unexpected identity read")
		return model.Principal{}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, slog.Default())
	for _, name := range []string{"Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"} {
		r := httptest.NewRequest("GET", "https://daynight.test/api/v1/me", nil)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		r.Header.Set("Sec-Fetch-Mode", "cors")
		r.Header.Set("Sec-Fetch-Dest", "empty")
		r.Header.Set(name, "same-origin")
		r.Header.Add(name, "same-origin")
		if h.sameOriginActivity(r) {
			t.Fatalf("accepted duplicate %s", name)
		}
	}
}
