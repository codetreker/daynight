package cors

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestPreflightRunsOnlyRouteLookup(t *testing.T) {
	mux := http.NewServeMux()
	called := 0
	mux.HandleFunc("GET /api/v1/resource", func(http.ResponseWriter, *http.Request) { called++ })
	mux.HandleFunc("/api/v1/resource", func(http.ResponseWriter, *http.Request) { called++ })
	h := Wrap(mux, mux, "https://client.example", slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tc := range []struct {
		name, method, headers string
		origins               []string
		status                int
	}{
		{"ordinary", "GET", "authorization, CONTENT-type", []string{"https://client.example"}, 204},
		{"implicit HEAD", "HEAD", "If-None-Match", []string{"https://client.example"}, 204},
		{"unknown method", "TRACE", "", []string{"https://client.example"}, 403},
		{"methodless fallback", "POST", "", []string{"https://client.example"}, 403},
		{"method case", "get", "", []string{"https://client.example"}, 403},
		{"missing method", "", "", []string{"https://client.example"}, 403},
		{"producer header", "GET", "Daynight-Controller-Fence", []string{"https://client.example"}, 403},
		{"malformed list", "GET", "Authorization,,Accept", []string{"https://client.example"}, 403},
		{"missing Origin", "GET", "", nil, 403},
		{"wrong Origin", "GET", "", []string{"https://other.example"}, 403},
		{"duplicate Origin", "GET", "", []string{"https://client.example", "https://client.example"}, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodOptions, "/api/v1/resource", nil)
			r.Header["Origin"] = tc.origins
			if tc.method != "" {
				r.Header.Set("Access-Control-Request-Method", tc.method)
			}
			if tc.headers != "" {
				r.Header.Set("Access-Control-Request-Headers", tc.headers)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || called != 0 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, called, w.Body.String())
			}
			if len(tc.origins) == 1 && tc.origins[0] == "https://client.example" && w.Header().Get("Access-Control-Allow-Origin") != tc.origins[0] {
				t.Fatal("legitimate preflight result is unreadable")
			}
			if w.Header().Get("Access-Control-Allow-Credentials") != "" || !strings.Contains(strings.Join(w.Header().Values("Vary"), ","), "Access-Control-Request-Headers") {
				t.Fatal("credential or preflight Vary contract changed")
			}
		})
	}
	for _, header := range []string{"Access-Control-Request-Method", "Access-Control-Request-Headers"} {
		r := httptest.NewRequest(http.MethodOptions, "/api/v1/resource", nil)
		r.Header.Set("Origin", "https://client.example")
		r.Header.Set("Access-Control-Request-Method", "GET")
		r.Header.Add(header, "GET")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 || called != 0 {
			t.Fatalf("duplicate/malformed %s reached business: %d calls=%d", header, w.Code, called)
		}
	}
}

func TestResponseDecorationPreservesExistingHeaders(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/resource", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Accept")
		w.Header().Set("ETag", `"revision"`)
		w.Header().Set("Location", "/api/v1/resource/1")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, "original conflict")
	})
	h := Wrap(mux, mux, "https://client.example", slog.New(slog.NewTextHandler(io.Discard, nil)))
	r := httptest.NewRequest(http.MethodGet, "/api/v1/resource", nil)
	r.Header.Set("Origin", "https://client.example")
	w := httptest.NewRecorder()
	w.Header().Set("Vary", "origin, Accept-Encoding")
	h.ServeHTTP(w, r)
	if w.Code != 409 || w.Body.String() != "original conflict" || w.Header().Get("ETag") != `"revision"` || w.Header().Get("Location") != "/api/v1/resource/1" {
		t.Fatalf("changed response: %d %s %v", w.Code, w.Body.String(), w.Header())
	}
	if strings.Join(w.Header().Values("Vary"), ", ") != "origin, Accept-Encoding, Accept" {
		t.Fatalf("Vary merged incorrectly: %v", w.Header().Values("Vary"))
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "https://client.example" || strings.Contains(w.Header().Get("Access-Control-Expose-Headers"), "Authorization") {
		t.Fatal("response Origin or secret exposure changed")
	}
}

func TestDisabledCORSAndIndependentRoutes(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		}
		w.WriteHeader(http.StatusAccepted)
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct{ path, origin, want string }{
		{"/api/v1/resource", "", ""}, {"/oauth/token", "https://client.example", "*"},
		{"/mcp", "https://client.example", ""}, {"/healthz", "https://client.example", ""},
		{"/assets/app.js", "https://client.example", ""}, {"/api/v1/oauth/s2s/token", "https://client.example", ""},
		{"/api/v1/native-callback", "https://client.example", ""}, {"/api/v1/controller-channel", "https://client.example", ""},
		{"/api/v1/assistant-task-inbox/22222222-2222-4222-8222-222222222222", "https://client.example", ""},
	} {
		r := httptest.NewRequest(http.MethodOptions, tc.path, nil)
		r.Header.Set("Origin", "https://client.example")
		w := httptest.NewRecorder()
		Wrap(mux, mux, tc.origin, logger, "/api/v1/native-callback").ServeHTTP(w, r)
		if w.Code != 202 || w.Header().Get("Access-Control-Allow-Origin") != tc.want {
			t.Fatalf("independent %s response changed: %d %v", tc.path, w.Code, w.Header())
		}
	}
}

func TestCredentialRouteCORSExclusions(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	h := Wrap(mux, mux, "https://client.example", slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tc := range []struct {
		path     string
		excluded bool
	}{
		{"/api/v2/me/tokens", true}, {"/api/v2/me/tokens/id/description", true},
		{"/api/v1/me/credential-scope-catalog", true}, {"/api/v2/auth/device/inspect", true}, {"/api/v2/auth/device/decision", true},
		{"/api/v2/auth/device/inspect/other", false},
		{"/api/v3/oauth/grants", true}, {"/api/v3/oauth/grants/id/description", true},
		{"/api/v2/me/tokens/id", false}, {"/api/v2/me/tokens/id/description/extra", false},
		{"/api/v2/me/tokens-extra", false}, {"/api/v1/me/tokens", false}, {"/api/v2/oauth/grants", false},
	} {
		for _, method := range []string{"GET", "OPTIONS"} {
			r := httptest.NewRequest(method, tc.path, nil)
			r.Header.Set("Origin", "https://client.example")
			r.Header.Set("Access-Control-Request-Method", "GET")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if got := w.Header().Get("Access-Control-Allow-Origin"); (got == "") != tc.excluded {
				t.Errorf("%s %s CORS origin = %q", method, tc.path, got)
			}
		}
	}
}

func TestScopeRefusalExposesStatusOnlyToConfiguredOrigin(t *testing.T) {
	mux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux.HandleFunc("GET /api/v1/resource", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, r, logger, "test", "read", &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."})
	})
	h := Wrap(mux, mux, "https://client.example", logger)
	for _, tc := range []struct {
		origin  string
		exposed bool
	}{{"https://client.example", true}, {"https://other.example", false}} {
		r := httptest.NewRequest(http.MethodGet, "/api/v1/resource", nil)
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"code":"forbidden"`) {
			t.Fatalf("scope refusal: %d %v %s", w.Code, w.Header(), w.Body.String())
		}
		hasExposure := false
		for _, name := range strings.Split(w.Header().Get("Access-Control-Expose-Headers"), ",") {
			if strings.EqualFold(strings.TrimSpace(name), "Daynight-Scope-Status") {
				hasExposure = true
			}
		}
		if hasExposure != tc.exposed || !strings.Contains(strings.ToLower(strings.Join(w.Header().Values("Vary"), ",")), "origin") {
			t.Fatalf("origin %s exposure %v headers %v", tc.origin, hasExposure, w.Header())
		}
	}
}
