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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	oauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/authorization"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

// This exercises the unmounted OAuth handlers with the real Session authenticator
// and PostgreSQL. It does not exercise a human browser or the future consent UI.
func TestOAuthAuthorizationControlledHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	session := h.Login(t, "oauth-acceptance-user")
	otherSession := h.Login(t, "oauth-acceptance-other")
	authRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	authRequest.AddCookie(session)
	principal, err := h.Auth.AuthenticateRequest(authRequest)
	if err != nil {
		t.Fatal(err)
	}
	admission := core.PublicAdmission{Writer: h.Database}
	clients, err := oauthservice.NewClients(h.Database, admission, map[string][]byte{
		"acceptance-client": []byte(`{"client_id":"acceptance-client","client_name":"Acceptance","redirect_uris":["https://client.example/callback"]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := oauthservice.NewAuthorizations(h.Database, clients, admission, h.Origin)
	if err != nil {
		t.Fatal(err)
	}
	adapter := oauthhttp.NewAuthorizationHTTP(service, h.Auth)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /oauth/authorize", adapter.Start)
	mux.HandleFunc("GET /api/v1/oauth/requests/{id}", adapter.Inspect)
	mux.HandleFunc("POST /api/v1/oauth/requests/{id}/decision", adapter.Decide)
	mux.HandleFunc("POST /oauth/token", adapter.RedeemCode)

	// When armed, finish the real operation and close the socket before sending
	// its response. A subsequent read establishes state, not the lost receipt.
	var cut atomic.Bool
	var cutCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && cut.CompareAndSwap(true, false) {
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, r)
			if recorder.Code != http.StatusOK {
				t.Errorf("cut operation returned %d", recorder.Code)
			}
			conn, _, err := http.NewResponseController(w).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			cutCount.Add(1)
			_ = conn.Close()
			return
		}
		mux.ServeHTTP(w, r)
	}))
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	send := func(method, path, body, contentType string, cookies ...*http.Cookie) (*http.Response, []byte, error) {
		req, err := http.NewRequestWithContext(ctx, method, server.URL+path, strings.NewReader(body))
		if err != nil {
			return nil, nil, err
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		if method == http.MethodPost {
			req.Header.Set("Origin", h.Origin)
		}
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, nil, err
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return resp, data, err
	}
	verifier := strings.Repeat("v", 43)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	const redirect = "https://client.example/callback"
	resource := h.Origin + "/mcp"
	start := func(state string) (string, *http.Cookie) {
		t.Helper()
		q := url.Values{"client_id": {"acceptance-client"}, "redirect_uri": {redirect}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {resource}, "state": {state}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}}
		resp, data, err := send(http.MethodGet, "/oauth/authorize?"+q.Encode(), "", "")
		if err != nil {
			t.Fatalf("start transport: %v", err)
		}
		if resp.StatusCode != http.StatusSeeOther {
			t.Fatalf("start status: %d body: %s", resp.StatusCode, data)
		}
		location, err := url.Parse(resp.Header.Get("Location"))
		if err != nil || location.Path != "/oauth/consent" || location.Query().Get("request") == "" {
			t.Fatal("invalid local consent redirect")
		}
		cookies := resp.Cookies()
		if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
			t.Fatal("missing browser binding")
		}
		return location.Query().Get("request"), cookies[0]
	}
	inspect := func(id string, binding *http.Cookie) map[string]any {
		t.Helper()
		resp, data, err := send(http.MethodGet, "/api/v1/oauth/requests/"+id, "", "", session, binding)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("inspect: %v", err)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("inspection cache policy")
		}
		var v map[string]any
		if err := json.Unmarshal(data, &v); err != nil {
			t.Fatal(err)
		}
		if _, ok := v["code"]; ok {
			t.Fatal("inspection exposed code")
		}
		if _, ok := v["state"]; ok {
			t.Fatal("inspection exposed state")
		}
		return v
	}
	decision := func(id string, binding *http.Cookie, action string) (*http.Response, []byte, error) {
		body, err := json.Marshal(map[string]string{"expectedUserId": principal.UserID, "decision": action})
		if err != nil {
			t.Fatal(err)
		}
		return send(http.MethodPost, "/api/v1/oauth/requests/"+id+"/decision", string(body), "application/json", session, binding)
	}
	approve := func(id string, binding *http.Cookie, state string) string {
		t.Helper()
		resp, data, err := decision(id, binding, "approve")
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("approve: %v", err)
		}
		var result struct {
			RedirectURI string `json:"redirectUri"`
		}
		if json.Unmarshal(data, &result) != nil {
			t.Fatal("decode decision")
		}
		u, err := url.Parse(result.RedirectURI)
		if err != nil || u.Scheme != "https" || u.Host != "client.example" || u.Path != "/callback" || u.Query().Get("iss") != h.Origin || u.Query().Get("state") != state || u.Query().Get("code") == "" {
			t.Fatal("unsafe or incomplete callback")
		}
		return u.Query().Get("code")
	}
	exchange := func(code, clientID, callback, res, proof string) (*http.Response, []byte, error) {
		v := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {clientID}, "redirect_uri": {callback}, "resource": {res}, "code_verifier": {proof}}
		return send(http.MethodPost, "/oauth/token", v.Encode(), "application/x-www-form-urlencoded")
	}

	id, binding := start("original-state")
	otherID, otherBinding := start("second-state")
	if id == otherID || binding.Name == otherBinding.Name {
		t.Fatal("concurrent requests replaced browser bindings")
	}
	inspect(id, binding)
	inspect(otherID, otherBinding)
	resp, _, err := send(http.MethodGet, "/api/v1/oauth/requests/"+id, "", "", session, otherBinding)
	if err != nil || resp.StatusCode == http.StatusOK {
		t.Fatal("foreign binding accepted")
	}
	changedBody, _ := json.Marshal(map[string]string{"expectedUserId": principal.UserID, "decision": "approve"})
	resp, _, err = send(http.MethodPost, "/api/v1/oauth/requests/"+id+"/decision", string(changedBody), "application/json", otherSession, binding)
	if err != nil || resp.StatusCode == http.StatusOK {
		t.Fatal("changed account accepted a stale decision")
	}
	if got := inspect(id, binding); got["status"] != "pending" {
		t.Fatalf("account mismatch changed request: %v", got["status"])
	}
	code := approve(id, binding, "original-state")
	for _, tc := range []struct{ client, callback, resource, proof string }{
		{"wrong", redirect, resource, verifier}, {"acceptance-client", "https://client.example/other", resource, verifier},
		{"acceptance-client", redirect, h.Origin + "/other", verifier}, {"acceptance-client", redirect, resource, strings.Repeat("w", 43)},
	} {
		r, _, e := exchange(code, tc.client, tc.callback, tc.resource, tc.proof)
		if e != nil || r.StatusCode != http.StatusBadRequest {
			t.Fatalf("mismatched exchange: %v", e)
		}
	}
	type result struct {
		status int
		body   []byte
		err    error
	}
	results := make(chan result, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, b, e := exchange(code, "acceptance-client", redirect, resource, verifier)
			status := 0
			if r != nil {
				status = r.StatusCode
			}
			results <- result{status, b, e}
		}()
	}
	wg.Wait()
	close(results)
	var access string
	successes, refusals := 0, 0
	for r := range results {
		if r.err != nil {
			t.Fatal(r.err)
		}
		switch r.status {
		case http.StatusOK:
			successes++
			var token struct {
				Access  string `json:"access_token"`
				Refresh string `json:"refresh_token"`
			}
			if json.Unmarshal(r.body, &token) != nil || token.Access == "" || token.Refresh == "" {
				t.Fatal("incomplete token family")
			}
			access = token.Access
		case http.StatusBadRequest:
			refusals++
		default:
			t.Fatalf("exchange status %d", r.status)
		}
	}
	if successes != 1 || refusals != 1 {
		t.Fatalf("concurrent redemption successes=%d refusals=%d", successes, refusals)
	}
	if _, err := oauthservice.NewAuthenticator(h.Database).AuthenticateAccess(ctx, access, resource); err == nil {
		t.Fatal("replay did not revoke winning access")
	}

	// A lost decision cannot be replayed to recover or mint a code.
	cut.Store(true)
	if _, _, err := decision(otherID, otherBinding, "approve"); err == nil {
		t.Fatal("decision response was not lost")
	}
	if got := inspect(otherID, otherBinding); got["status"] != "approved" {
		t.Fatalf("lost decision state: %v", got["status"])
	}
	if r, _, e := decision(otherID, otherBinding, "approve"); e != nil || r.StatusCode == http.StatusOK {
		t.Fatal("lost decision was repeated")
	}

	lostID, lostBinding := start("lost-token")
	lostCode := approve(lostID, lostBinding, "lost-token")
	cut.Store(true)
	if _, _, err := exchange(lostCode, "acceptance-client", redirect, resource, verifier); err == nil {
		t.Fatal("token response was not lost")
	}
	if got := inspect(lostID, lostBinding); got["status"] != "consumed" {
		t.Fatalf("lost token state: %v", got["status"])
	}
	if cutCount.Load() != 2 {
		t.Fatalf("wire cuts: %d", cutCount.Load())
	}
	deniedID, deniedBinding := start("denied-state")
	deniedResponse, deniedBody, err := decision(deniedID, deniedBinding, "deny")
	if err != nil || deniedResponse.StatusCode != http.StatusOK {
		t.Fatal("deny failed")
	}
	var denied struct {
		RedirectURI string `json:"redirectUri"`
	}
	if json.Unmarshal(deniedBody, &denied) != nil {
		t.Fatal("decode denial")
	}
	deniedURL, err := url.Parse(denied.RedirectURI)
	if err != nil || deniedURL.Scheme != "https" || deniedURL.Host != "client.example" || deniedURL.Path != "/callback" || deniedURL.Query().Get("error") != "access_denied" || deniedURL.Query().Get("state") != "denied-state" || deniedURL.Query().Get("iss") != h.Origin || deniedURL.Query().Has("code") {
		t.Fatal("invalid denial callback")
	}
	if got := inspect(deniedID, deniedBinding); got["status"] != "denied" {
		t.Fatalf("denial state: %v", got["status"])
	}
	var grants, accesses, refreshes, residualStates int
	if err := h.Database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens), (SELECT count(*) FROM oauth_authorizations WHERE state <> '')`).Scan(&grants, &accesses, &refreshes, &residualStates); err != nil {
		t.Fatal(err)
	}
	if grants != 2 || accesses != 1 || refreshes != 2 || residualStates != 0 {
		t.Fatalf("unexpected persistence: grants=%d accesses=%d refreshes=%d retained_states=%d", grants, accesses, refreshes, residualStates)
	}
}
