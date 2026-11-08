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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	tokenhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// The future production profile is not mounted here. This exercises the final
// public adapter with real authorization transactions and persisted budgets.
func TestOAuthTokenLifecycleControlledHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	cookie := h.Login(t, "oauth-token-lifecycle")
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(cookie)
	principal, err := h.Auth.AuthenticateRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Now().UTC()
	admission := core.PublicAdmission{Writer: h.Database, Now: func() time.Time { return fixedNow }}
	clients, err := oauthservice.NewClients(h.Database, admission, map[string][]byte{"acceptance-client": []byte(`{"client_id":"acceptance-client","client_name":"Acceptance","redirect_uris":["https://client.example/callback"]}`)})
	if err != nil {
		t.Fatal(err)
	}
	authorizations, err := oauthservice.NewAuthorizations(h.Database, clients, admission, h.Origin)
	if err != nil {
		t.Fatal(err)
	}
	grants := core.NewGrantLifecycle(h.Database)
	adapter := &tokenhttp.PublicTokens{Admission: admission, Resource: h.Origin + "/mcp", Codes: authorizations, Grants: grants}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", adapter.Token)
	mux.HandleFunc("/oauth/revoke", adapter.Revoke)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	verifier := strings.Repeat("v", 43)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	resource := h.Origin + "/mcp"
	const callback = "https://client.example/callback"
	code := func() string {
		t.Helper()
		start, e := authorizations.Start(ctx, oauthservice.StartInput{Source: "fixture", ClientID: "acceptance-client", RedirectURI: callback, ResponseType: "code", Scope: core.Scope, Resource: resource, CodeChallenge: challenge, CodeChallengeMethod: "S256"})
		if e != nil {
			t.Fatal(e)
		}
		decision, e := authorizations.Decide(ctx, oauthservice.DecisionInput{RequestID: start.RequestID, Binding: start.Binding, ExpectedUserID: principal.UserID, Decision: "approve", Principal: principal})
		if e != nil {
			t.Fatal(e)
		}
		u, e := url.Parse(decision.RedirectURI)
		if e != nil || u.Query().Get("code") == "" {
			t.Fatalf("decision callback: %v", e)
		}
		return u.Query().Get("code")
	}
	post := func(path string, v url.Values) (int, []byte) {
		t.Helper()
		req, e := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, strings.NewReader(v.Encode()))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		b, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("credential response lacks no-store")
		}
		return resp.StatusCode, b
	}
	type tokens struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Type    string `json:"token_type"`
		Scope   string `json:"scope"`
		Expires int64  `json:"expires_in"`
	}
	exchange := func(c string) tokens {
		t.Helper()
		status, b := post("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {c}, "client_id": {"acceptance-client"}, "redirect_uri": {callback}, "resource": {resource}, "code_verifier": {verifier}})
		var out tokens
		if status != 200 || json.Unmarshal(b, &out) != nil || out.Access == "" || out.Refresh == "" || out.Type != "Bearer" || out.Scope != core.Scope || out.Expires <= 0 {
			t.Fatalf("exchange: %d %s", status, b)
		}
		return out
	}
	refreshForm := func(token, clientID, res string) url.Values {
		return url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {clientID}, "resource": {res}}
	}
	first := exchange(code())
	for _, v := range []url.Values{refreshForm(first.Refresh, "wrong", resource), refreshForm(first.Refresh, "acceptance-client", h.Origin+"/other")} {
		if status, _ := post("/oauth/token", v); status != http.StatusBadRequest {
			t.Fatalf("wrong binding status: %d", status)
		}
	}
	status, b := post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource))
	var rotated tokens
	if status != 200 || json.Unmarshal(b, &rotated) != nil || rotated.Access == "" || rotated.Refresh == "" || rotated.Refresh == first.Refresh {
		t.Fatalf("rotation: %d %s", status, b)
	}
	auth := oauthservice.NewAuthenticator(h.Database)
	if _, err = auth.AuthenticateAccess(ctx, rotated.Access, resource); err != nil {
		t.Fatalf("rotated access rejected: %v", err)
	}
	if status, _ = post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource)); status != http.StatusBadRequest {
		t.Fatalf("replay status: %d", status)
	}
	for _, access := range []string{first.Access, rotated.Access} {
		if _, err = auth.AuthenticateAccess(ctx, access, resource); err == nil {
			t.Fatal("replay left access usable")
		}
	}
	second := exchange(code())
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"wrong"}}); status != http.StatusOK {
		t.Fatalf("wrong client revoke: %d", status)
	}
	if _, err = auth.AuthenticateAccess(ctx, second.Access, resource); err != nil {
		t.Fatal("wrong client revoked access")
	}
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"acceptance-client"}}); status != http.StatusOK {
		t.Fatalf("revoke: %d", status)
	}
	if _, err = auth.AuthenticateAccess(ctx, second.Access, resource); err == nil {
		t.Fatal("public revoke left access usable")
	}
	// Global/source count every token request once; only four requests had a
	// verified client binding. The wrong client never obtains an actor bucket.
	for _, tc := range []struct {
		key  string
		want int
	}{{"oauth:token:global", 6}, {"oauth:token:source:127.0.0.1", 6}, {"oauth:token:client:acceptance-client", 4}} {
		var attempts int
		if err := h.Database.Pool.QueryRow(ctx, `SELECT attempts FROM device_authorization_limits WHERE bucket_hash=$1`, secret.Hash(tc.key)).Scan(&attempts); err != nil || attempts != tc.want {
			t.Fatalf("budget %s: %d %v", tc.key, attempts, err)
		}
	}
	var wrong int
	if err := h.Database.Pool.QueryRow(ctx, `SELECT count(*) FROM device_authorization_limits WHERE bucket_hash=$1`, secret.Hash("oauth:token:client:wrong")).Scan(&wrong); err != nil || wrong != 0 {
		t.Fatalf("unverified client budget: %d %v", wrong, err)
	}
}
