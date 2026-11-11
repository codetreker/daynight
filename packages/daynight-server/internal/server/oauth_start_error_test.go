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
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProductionOAuthInvalidClientAndCallbackErrorPage(t *testing.T) {
	fixture := newOAuthHTTPFixture(t)
	config := configuredTestConfig()
	handler, err := newTestHandler(Dependencies{Store: fixture.Store, Files: attachmentTestFiles(t)}, config, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer handler.(Handler).Shutdown(context.Background())
	registrationPlan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "client_insert": 1})
	var issuedID string
	dao := &oauthHTTPClientDAO{t: t, plan: registrationPlan, insert: func(client store.OAuthClient, capacity int, now time.Time) (bool, error) {
		var metadata core.ClientMetadata
		if err := json.Unmarshal(client.Metadata, &metadata); err != nil {
			t.Errorf("registered metadata: %v", err)
		}
		want := core.ClientMetadata{ClientID: client.ID, ClientName: "example", RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none"}
		if client.ID == "" || !strings.HasPrefix(client.ID, "dnoac_") || !reflect.DeepEqual(metadata, want) || capacity != 10000 || now.IsZero() || now.Location() != time.UTC || client.CreatedAt != now || client.LastUsedAt != now || client.ExpiresAt != now.Add(7*24*time.Hour) {
			t.Errorf("client registration arguments: %#v %#v capacity=%d at=%v", client, metadata, capacity, now)
		}
		issuedID = client.ID
		return true, nil
	}}
	fixture.Store.WriteOAuthClientsCall = func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
		registrationPlan.Called("transaction")
		err := fn(oauthHTTPClientScope{clients: dao})
		return oauthHTTPCompletion(err), err
	}
	registration := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(`{"client_name":"example","redirect_uris":["https://client.example/callback"]}`))
	registration.RemoteAddr = "127.0.0.1:1234"
	registration.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, registration)
	var client struct {
		ID string `json:"client_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &client); err != nil || w.Code != http.StatusCreated || client.ID == "" || client.ID != issuedID {
		t.Fatalf("register status: %d %v", w.Code, err)
	}
	registrationPlan.Verify()
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	for _, clientID := range []string{"unknown-client", client.ID} {
		plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "client_read": 1})
		lookup := &oauthHTTPClientDAO{t: t, plan: plan, read: func(id string, lock bool) (store.OAuthClient, error) {
			if id != clientID || !lock {
				t.Errorf("client lookup arguments: %q lock=%v, want %q/true", id, lock, clientID)
			}
			if clientID == "unknown-client" {
				return store.OAuthClient{}, model.ErrNotFound
			}
			metadata, err := json.Marshal(core.ClientMetadata{ClientID: issuedID, ClientName: "example", RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none"})
			if err != nil {
				t.Error(err)
			}
			return store.OAuthClient{ID: issuedID, Metadata: metadata, CreatedAt: fixture.Now, LastUsedAt: fixture.Now, ExpiresAt: fixture.Now.Add(time.Hour)}, nil
		}}
		fixture.Store.WriteOAuthClientsCall = func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
			plan.Called("transaction")
			err := fn(oauthHTTPClientScope{clients: lookup})
			return oauthHTTPCompletion(err), err
		}
		q := url.Values{"client_id": {clientID}, "redirect_uri": {"https://evil.example/callback"}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {config.Server.PublicOrigin + "/mcp"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
		r := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || w.Header().Get("Location") != "" || w.Header().Get("X-OAuth-Error") != "invalid_client" || w.Header().Get("Referrer-Policy") != "no-referrer" || strings.Contains(w.Body.String(), "evil.example") {
			t.Fatalf("invalid start: %d %v", w.Code, w.Header())
		}
		plan.Verify()
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	for key, count := range map[string]int{"oauth:register:global": 1, "oauth:register:source:127.0.0.1": 1, "oauth:start:global": 2, "oauth:start:source:127.0.0.1": 2} {
		if fixture.Rates[key] != count {
			t.Errorf("admission calls for %s: %d, want %d", key, fixture.Rates[key], count)
		}
	}
}
