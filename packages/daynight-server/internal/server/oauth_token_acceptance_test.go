package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tokenhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestOAuthTokenLifecycleControlledHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f := newOAuthHTTPFixture(t)
	adapter := &tokenhttp.PublicTokens{Admission: f.admission, Resource: f.Origin + "/mcp", Codes: f.Ops, Grants: f.Ops}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", adapter.Token)
	mux.HandleFunc("/oauth/revoke", adapter.Revoke)
	server := httptest.NewServer(markOAuthHTTPRequests(mux))
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	verifier := strings.Repeat("v", 43)
	const callback = "https://client.example/callback"
	resource := f.Origin + "/mcp"
	code := func() (string, store.OAuthAuthorization) {
		t.Helper()
		raw := secret.Random("dnoc_")
		pending := oauthHTTPPending(f, uuid.NewString(), secret.Random("dnob_"), "", "acceptance-client", callback, "preregistered")
		pending.StatePresent = false
		return raw, oauthHTTPApproved(f, pending, raw)
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
		oauthHTTPExpectRedeem(t, f, row, true, false, false, &issue, oauthservice.RedeemInput{Code: c, ClientID: "acceptance-client", RedirectURI: callback, Resource: resource, Verifier: verifier})
		status, b := post("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {c}, "client_id": {"acceptance-client"}, "redirect_uri": {callback}, "resource": {resource}, "code_verifier": {verifier}})
		var out tokens
		if status != 200 || json.Unmarshal(b, &out) != nil || out.Access == "" || out.Refresh == "" || out.Type != "Bearer" || out.Scope != core.Scope || out.Expires <= 0 {
			t.Fatalf("exchange: %d %s", status, b)
		}
		oauthHTTPAssertTokens(t, b, f.ExpectedTokens)
		if !bytesEqualOAuthHash(out.Access, issue.AccessHash) || !bytesEqualOAuthHash(out.Refresh, issue.RefreshHash) {
			t.Fatal("token secrets differ from configured hashes")
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
	f.Ops.RotateFn = nil
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
	oauthHTTPAssertTokens(t, b, f.ExpectedTokens)
	if !bytesEqualOAuthHash(rotated.Access, rotation.AccessHash) || !bytesEqualOAuthHash(rotated.Refresh, rotation.RefreshHash) {
		t.Fatal("rotated secrets differ from configured hashes")
	}
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, true, false, &unused)
	if status, _ = post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource)); status != http.StatusBadRequest {
		t.Fatalf("replay status: %d", status)
	}
	second, secondIssue := exchange()
	oauthHTTPExpectRevoke(t, f, second.Refresh, secondIssue.Grant, true)
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"wrong"}}); status != http.StatusOK {
		t.Fatalf("wrong client revoke: %d", status)
	}
	oauthHTTPExpectRevoke(t, f, second.Refresh, secondIssue.Grant, false)
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"acceptance-client"}}); status != http.StatusOK {
		t.Fatalf("revoke: %d", status)
	}
	for _, tc := range []struct {
		key  string
		want int
	}{{"oauth:token:global", 6}, {"oauth:token:source:127.0.0.1", 6}, {"oauth:token:client:acceptance-client", 4}} {
		if f.Rates[tc.key] != tc.want {
			t.Fatalf("token admission calls %s: %d want %d", tc.key, f.Rates[tc.key], tc.want)
		}
	}
	if f.Rates["oauth:token:client:wrong"] != 0 {
		t.Fatal("unverified client obtained a budget")
	}
}
