package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestProductionOAuthInvalidClientAndCallbackErrorPage(t *testing.T) {
	db := projectTestStore(t)
	config := configuredTestConfig()
	handler, err := newTestHandler(Dependencies{Store: db, Ready: db.Ready, Files: attachmentTestFiles(t)}, config, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer handler.(Handler).Shutdown(context.Background())
	registration := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(`{"client_name":"example","redirect_uris":["https://client.example/callback"]}`))
	registration.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, registration)
	var client struct {
		ID string `json:"client_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &client); err != nil || w.Code != http.StatusCreated || client.ID == "" {
		t.Fatalf("register status: %d %v", w.Code, err)
	}
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	for _, clientID := range []string{"unknown-client", client.ID} {
		q := url.Values{"client_id": {clientID}, "redirect_uri": {"https://evil.example/callback"}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {config.PublicOrigin + "/mcp"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
		r := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil)
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || w.Header().Get("Location") != "" || w.Header().Get("X-OAuth-Error") != "invalid_client" || w.Header().Get("Referrer-Policy") != "no-referrer" || strings.Contains(w.Body.String(), "evil.example") {
			t.Fatalf("invalid start: %d %v", w.Code, w.Header())
		}
	}
}
