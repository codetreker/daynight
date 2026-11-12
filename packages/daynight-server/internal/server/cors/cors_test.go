package cors

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
