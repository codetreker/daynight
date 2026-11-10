package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestProductionOAuthInvalidClientAndCallbackErrorPage(t *testing.T) {
	fixture := newOAuthHTTPFixture(t)
	config := configuredTestConfig()
	identity := &operationHTTPIdentity{t: t, CallbackURLFn: func() string { return config.UniAuthCallbackURL }}
	handler := newOperationHTTPServerWithConfig(t, identity, func(d *httpDependencies) { d.Registration, d.Authorizations = fixture.Ops, fixture.Ops }, io.Discard, fixture.Principal, config)
	issuedID := secret.Random("dnoac_")
	oauthHTTPExpectRegistration(t, fixture, `{"client_name":"example","redirect_uris":["https://client.example/callback"]}`, core.ClientMetadata{ClientID: issuedID, ClientName: "example", RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none"})
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
	oauthHTTPAssertRegistration(t, w.Body.Bytes(), core.ClientMetadata{ClientID: issuedID, ClientName: "example", RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none"})
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	for _, clientID := range []string{"unknown-client", client.ID} {
		called := oauthHTTPCount(t, 1)
		fixture.Ops.StartFn = func(ctx context.Context, in oauthservice.StartInput) (oauthservice.StartResult, error) {
			called()
			oauthHTTPDirectContext(t, ctx)
			oauthHTTPCheck(t, in, oauthservice.StartInput{Source: "127.0.0.1", ClientID: clientID, RedirectURI: "https://evil.example/callback", ResponseType: "code", Scope: core.Scope, Resource: config.PublicOrigin + "/mcp", CodeChallenge: base64.RawURLEncoding.EncodeToString(challenge[:]), CodeChallengeMethod: "S256"})
			fixture.mu.Lock()
			fixture.Starts[in.Source]++
			fixture.mu.Unlock()
			return oauthservice.StartResult{}, core.ErrInvalidClient
		}
		q := url.Values{"client_id": {clientID}, "redirect_uri": {"https://evil.example/callback"}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {config.PublicOrigin + "/mcp"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
		r := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || w.Header().Get("Location") != "" || w.Header().Get("X-OAuth-Error") != "invalid_client" || w.Header().Get("Referrer-Policy") != "no-referrer" || strings.Contains(w.Body.String(), "evil.example") {
			t.Fatalf("invalid start: %d %v", w.Code, w.Header())
		}
	}
	if fixture.Starts["127.0.0.1"] != 2 {
		t.Fatalf("authorization Start calls: %+v", fixture.Starts)
	}
}
