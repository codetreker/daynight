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
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tokenhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

func TestOAuthTokenLifecycleControlledHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f := newOAuthHTTPFixture(t)
	admission := core.PublicAdmission{Writer: f.Store, Now: func() time.Time { return f.Now }}
	clients, err := oauthservice.NewClients(f.Store, admission, map[string][]byte{"acceptance-client": []byte(`{"client_id":"acceptance-client","client_name":"Acceptance","redirect_uris":["https://client.example/callback"]}`)})
	if err != nil {
		t.Fatal(err)
	}
	authorizations, err := oauthservice.NewAuthorizations(f.Store, clients, admission, f.Origin)
	if err != nil {
		t.Fatal(err)
	}
	adapter := &tokenhttp.PublicTokens{Admission: admission, Resource: f.Origin + "/mcp", Codes: authorizations, Grants: core.NewGrantLifecycle(f.Store)}
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
	const callback = "https://client.example/callback"
	resource := f.Origin + "/mcp"
	code := func() (string, store.OAuthAuthorization) {
		t.Helper()
		startCapture := oauthHTTPExpectStart(t, f, "acceptance-client", callback, "")
		start, e := authorizations.Start(ctx, oauthservice.StartInput{Source: "fixture", ClientID: "acceptance-client", RedirectURI: callback, ResponseType: "code", Scope: core.Scope, Resource: resource, CodeChallenge: challenge, CodeChallengeMethod: "S256"})
		if e != nil {
			t.Fatal(e)
		}
		if captured := startCapture.Load(); captured == nil || captured.ID != start.RequestID || !bytesEqualOAuthHash(start.Binding, captured.BindingHash) {
			t.Fatal("authorization start differs from inserted request/binding")
		}
		pending := oauthHTTPPending(f, start.RequestID, start.Binding, "", "acceptance-client", callback, "preregistered")
		pending.StatePresent = false
		decisionCapture := oauthHTTPDecision(t, f, pending, "approved")
		decision, e := authorizations.Decide(ctx, oauthservice.DecisionInput{RequestID: start.RequestID, Binding: start.Binding, ExpectedUserID: f.Principal.UserID, Decision: "approve", Principal: f.Principal})
		if e != nil {
			t.Fatal(e)
		}
		u, e := url.Parse(decision.RedirectURI)
		if e != nil || u.Query().Get("code") == "" {
			t.Fatalf("decision callback: %v", e)
		}
		if captured := decisionCapture.Load(); captured == nil || !bytesEqualOAuthHash(u.Query().Get("code"), captured.CodeHash) {
			t.Fatal("authorization code differs from candidate hash")
		}
		return u.Query().Get("code"), oauthHTTPApproved(f, pending, u.Query().Get("code"))
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
	exchange := func() (tokens, store.OAuthFamilyIssue) {
		t.Helper()
		c, row := code()
		var issue store.OAuthFamilyIssue
		oauthHTTPExpectRedeem(t, f, row, true, false, false, &issue)
		status, b := post("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {c}, "client_id": {"acceptance-client"}, "redirect_uri": {callback}, "resource": {resource}, "code_verifier": {verifier}})
		var out tokens
		if status != 200 || json.Unmarshal(b, &out) != nil || out.Access == "" || out.Refresh == "" || out.Type != "Bearer" || out.Scope != core.Scope || out.Expires <= 0 {
			t.Fatalf("exchange: %d %s", status, b)
		}
		if !bytesEqualOAuthHash(out.Access, issue.AccessHash) || !bytesEqualOAuthHash(out.Refresh, issue.RefreshHash) {
			t.Fatal("token secrets differ from issued hashes")
		}
		return out, issue
	}
	refreshForm := func(token, clientID, res string) url.Values {
		return url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {clientID}, "resource": {res}}
	}
	first, firstIssue := exchange()
	var unused store.OAuthRotation
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, false, true, &unused)
	if status, _ := post("/oauth/token", refreshForm(first.Refresh, "wrong", resource)); status != http.StatusBadRequest {
		t.Fatalf("wrong client status: %d", status)
	}
	f.Store.WriteGrantLifecycleCall = nil
	if status, _ := post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", f.Origin+"/other")); status != http.StatusBadRequest {
		t.Fatalf("wrong resource status: %d", status)
	}
	var rotation store.OAuthRotation
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, false, false, &rotation)
	status, b := post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource))
	var rotated tokens
	if status != 200 || json.Unmarshal(b, &rotated) != nil || rotated.Access == "" || rotated.Refresh == "" || rotated.Refresh == first.Refresh {
		t.Fatalf("rotation: %d %s", status, b)
	}
	if !bytesEqualOAuthHash(rotated.Access, rotation.AccessHash) || !bytesEqualOAuthHash(rotated.Refresh, rotation.RefreshHash) {
		t.Fatal("rotated secrets differ from candidate hashes")
	}
	auth := oauthservice.NewAuthenticator(f.Store)
	principal := model.Principal{Kind: model.OAuthCredential, UserID: f.Principal.UserID, CredentialID: rotation.AccessID}
	oauthHTTPExpectAccess(t, f, rotated.Access, resource, principal, firstIssue.Grant.ID, nil)
	if _, err = auth.AuthenticateAccess(ctx, rotated.Access, resource); err != nil {
		t.Fatalf("rotated access rejected: %v", err)
	}
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, true, false, &unused)
	if status, _ = post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource)); status != http.StatusBadRequest {
		t.Fatalf("replay status: %d", status)
	}
	for _, access := range []string{first.Access, rotated.Access} {
		oauthHTTPExpectAccess(t, f, access, resource, model.Principal{}, "", model.ErrNotFound)
		if _, err = auth.AuthenticateAccess(ctx, access, resource); err == nil {
			t.Fatal("replay left access usable")
		}
	}
	second, secondIssue := exchange()
	oauthHTTPExpectRevoke(t, f, second.Refresh, secondIssue.Grant, true)
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"wrong"}}); status != http.StatusOK {
		t.Fatalf("wrong client revoke: %d", status)
	}
	principal.CredentialID = secondIssue.AccessID
	oauthHTTPExpectAccess(t, f, second.Access, resource, principal, secondIssue.Grant.ID, nil)
	if _, err = auth.AuthenticateAccess(ctx, second.Access, resource); err != nil {
		t.Fatal("wrong client revoked access")
	}
	oauthHTTPExpectRevoke(t, f, second.Refresh, secondIssue.Grant, false)
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"acceptance-client"}}); status != http.StatusOK {
		t.Fatalf("revoke: %d", status)
	}
	oauthHTTPExpectAccess(t, f, second.Access, resource, model.Principal{}, "", model.ErrNotFound)
	if _, err = auth.AuthenticateAccess(ctx, second.Access, resource); err == nil {
		t.Fatal("public revoke left access usable")
	}
	for _, tc := range []struct {
		key  string
		want int
	}{{"oauth:token:global", 6}, {"oauth:token:source:127.0.0.1", 6}, {"oauth:token:client:acceptance-client", 4}} {
		if f.Rates[tc.key] != tc.want {
			t.Fatalf("budget DAO calls %s: %d want %d", tc.key, f.Rates[tc.key], tc.want)
		}
	}
	if f.Rates["oauth:token:client:wrong"] != 0 {
		t.Fatal("unverified client obtained a budget")
	}
}
