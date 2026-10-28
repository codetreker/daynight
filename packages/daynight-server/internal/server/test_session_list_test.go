package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTestSessionListAuthenticationAndQuery(t *testing.T) {
	f := sessionHTTPSetup(t)
	response := projectRequest(f.handler, http.MethodGet, "/api/v1/test-sessions", "")
	page := decodeResponse[struct {
		Items      []map[string]any `json:"items"`
		NextCursor *string          `json:"nextCursor"`
	}](t, response, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatal("empty owner list", page)
	}
	anonymous := httptest.NewRecorder()
	f.handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/v1/test-sessions", nil))
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatal("anonymous list", anonymous.Code)
	}
	for _, query := range []string{"?unknown=1", "?limit=0", "?limit=101", "?limit=wrong", "?limit=1&limit=2", "?cursor=bad", "?cursor=", "?limit=", "?online=", "?online=1", "?online=yes", "?online=TRUE", "?online=true&online=false"} {
		if r := projectRequest(f.handler, http.MethodGet, "/api/v1/test-sessions"+query, ""); r.Code != http.StatusBadRequest {
			t.Fatal(query, r.Code, r.Body.String())
		}
	}
	for _, query := range []string{"?online=true", "?online=false", "?online=true&limit=1"} {
		if r := projectRequest(f.handler, http.MethodGet, "/api/v1/test-sessions"+query, ""); r.Code != http.StatusOK {
			t.Fatal(query, r.Code, r.Body.String())
		}
	}
	for _, method := range []string{http.MethodHead, http.MethodPatch} {
		r := projectRequest(f.handler, method, "/api/v1/test-sessions", "")
		if r.Code != http.StatusMethodNotAllowed || r.Header().Get("Allow") != "GET, POST" {
			t.Fatal("method", method, r.Code, r.Header())
		}
	}
}

func TestTestSessionListCallbackPathIsReserved(t *testing.T) {
	config := AuthConfig{PublicOrigin: "https://daynight.example.com"}
	for _, path := range []string{"/test-sessions", "/test-sessions/one", "/api/v1/test-sessions", "/api/v1/test-sessions/one"} {
		if _, _, err := validateAuthSettings(config, config.PublicOrigin+path); err == nil {
			t.Fatal("callback overlaps session route", path)
		}
	}
	if _, _, err := validateAuthSettings(config, config.PublicOrigin+"/test-sessions-callback"); err != nil {
		t.Fatal("independent callback refused", err)
	}
}
