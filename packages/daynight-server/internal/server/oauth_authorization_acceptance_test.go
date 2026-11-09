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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	oauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/authorization"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

func TestOAuthAuthorizationControlledHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	h := newOAuthHTTPFixture(t)
	session, otherSession, principal := h.Session, h.OtherSession, h.Principal
	admission := core.PublicAdmission{Writer: h.Store}
	clients, err := oauthservice.NewClients(h.Store, admission, map[string][]byte{
		"acceptance-client": []byte(`{"client_id":"acceptance-client","client_name":"Acceptance","redirect_uris":["https://client.example/callback"]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	service, err := oauthservice.NewAuthorizations(h.Store, clients, admission, h.Origin)
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
	cutCompleted := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && cut.CompareAndSwap(true, false) {
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, r)
			if recorder.Code != http.StatusOK {
				t.Errorf("cut operation returned %d", recorder.Code)
			}
			// Socket loss does not synchronize fixture captures with the client.
			// Publish completion after the actual operation has returned.
			cutCompleted <- struct{}{}
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
		startCapture := oauthHTTPExpectStart(t, h, "acceptance-client", redirect, state)
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
		if captured := startCapture.Load(); captured == nil || captured.ID != location.Query().Get("request") || !bytesEqualOAuthHash(cookies[0].Value, captured.BindingHash) {
			t.Fatal("authorization response differs from inserted request/binding")
		}
		return location.Query().Get("request"), cookies[0]
	}
	inspect := func(row store.OAuthAuthorization, binding *http.Cookie) map[string]any {
		t.Helper()
		id := row.ID
		oauthHTTPRead(t, h, row)
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
	var decisionCapture *atomic.Pointer[store.OAuthAuthorization]
	decision := func(row store.OAuthAuthorization, binding *http.Cookie, action string) (*http.Response, []byte, error) {
		id := row.ID
		status := "approved"
		if action == "deny" {
			status = "denied"
		}
		decisionCapture = oauthHTTPDecision(t, h, row, status)
		body, err := json.Marshal(map[string]string{"expectedUserId": principal.UserID, "decision": action})
		if err != nil {
			t.Fatal(err)
		}
		return send(http.MethodPost, "/api/v1/oauth/requests/"+id+"/decision", string(body), "application/json", session, binding)
	}
	approve := func(row store.OAuthAuthorization, binding *http.Cookie, state string) string {
		t.Helper()
		resp, data, err := decision(row, binding, "approve")
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
		if captured := decisionCapture.Load(); captured == nil || !bytesEqualOAuthHash(u.Query().Get("code"), captured.CodeHash) {
			t.Fatal("approval response code differs from candidate hash")
		}
		return u.Query().Get("code")
	}
	exchange := func(code, clientID, callback, res, proof string) (*http.Response, []byte, error) {
		v := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "client_id": {clientID}, "redirect_uri": {callback}, "resource": {res}, "code_verifier": {proof}}
		return send(http.MethodPost, "/oauth/token", v.Encode(), "application/x-www-form-urlencoded")
	}

	id, binding := start("original-state")
	otherID, otherBinding := start("second-state")
	pending := oauthHTTPPending(h, id, binding.Value, "original-state", "acceptance-client", redirect, "preregistered")
	otherPending := oauthHTTPPending(h, otherID, otherBinding.Value, "second-state", "acceptance-client", redirect, "preregistered")
	if id == otherID || binding.Name == otherBinding.Name {
		t.Fatal("concurrent requests replaced browser bindings")
	}
	inspect(pending, binding)
	inspect(otherPending, otherBinding)
	resp, _, err := send(http.MethodGet, "/api/v1/oauth/requests/"+id, "", "", session, otherBinding)
	if err != nil || resp.StatusCode == http.StatusOK {
		t.Fatal("foreign binding accepted")
	}
	changedBody, _ := json.Marshal(map[string]string{"expectedUserId": principal.UserID, "decision": "approve"})
	resp, _, err = send(http.MethodPost, "/api/v1/oauth/requests/"+id+"/decision", string(changedBody), "application/json", otherSession, binding)
	if err != nil || resp.StatusCode == http.StatusOK {
		t.Fatal("changed account accepted a stale decision")
	}
	if got := inspect(pending, binding); got["status"] != "pending" {
		t.Fatalf("account mismatch changed request: %v", got["status"])
	}
	code := approve(pending, binding, "original-state")
	approved := oauthHTTPApproved(h, pending, code)
	for _, tc := range []struct{ client, callback, resource, proof string }{
		{"wrong", redirect, resource, verifier}, {"acceptance-client", "https://client.example/other", resource, verifier},
		{"acceptance-client", redirect, h.Origin + "/other", verifier}, {"acceptance-client", redirect, resource, strings.Repeat("w", 43)},
	} {
		if tc.resource == resource {
			var unused store.OAuthFamilyIssue
			oauthHTTPExpectRedeem(t, h, approved, false, false, true, &unused)
		} else {
			h.Store.WriteAuthorizationsCall = nil
		}
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
	var winning store.OAuthFamilyIssue
	oauthHTTPConcurrentRedeem(t, h, approved, &winning)
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
			if !bytesEqualOAuthHash(token.Access, winning.AccessHash) || !bytesEqualOAuthHash(token.Refresh, winning.RefreshHash) {
				t.Fatal("redemption response secrets differ from issued hashes")
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
	oauthHTTPExpectAccess(t, h, access, resource, model.Principal{}, "", model.ErrNotFound)
	if _, err := oauthservice.NewAuthenticator(h.Store).AuthenticateAccess(ctx, access, resource); err == nil {
		t.Fatal("replay did not revoke winning access")
	}

	// A lost decision cannot be replayed to recover or mint a code.
	cut.Store(true)
	if _, _, err := decision(otherPending, otherBinding, "approve"); err == nil {
		t.Fatal("decision response was not lost")
	}
	await(t, cutCompleted)
	otherApproved := oauthHTTPApproved(h, otherPending, "dnoc_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	if got := inspect(otherApproved, otherBinding); got["status"] != "approved" {
		t.Fatalf("lost decision state: %v", got["status"])
	}
	if r, _, e := decision(otherApproved, otherBinding, "approve"); e != nil || r.StatusCode == http.StatusOK {
		t.Fatal("lost decision was repeated")
	}

	lostID, lostBinding := start("lost-token")
	lostPending := oauthHTTPPending(h, lostID, lostBinding.Value, "lost-token", "acceptance-client", redirect, "preregistered")
	lostCode := approve(lostPending, lostBinding, "lost-token")
	lostApproved := oauthHTTPApproved(h, lostPending, lostCode)
	var lostIssue store.OAuthFamilyIssue
	oauthHTTPExpectRedeem(t, h, lostApproved, false, false, false, &lostIssue)
	cut.Store(true)
	if _, _, err := exchange(lostCode, "acceptance-client", redirect, resource, verifier); err == nil {
		t.Fatal("token response was not lost")
	}
	await(t, cutCompleted)
	lostConsumed := lostApproved
	lostConsumed.Status = "consumed"
	lostConsumed.GrantID = lostIssue.Grant.ID
	lostConsumed.RetainUntil = h.Now.Add(core.GrantLifetime)
	if got := inspect(lostConsumed, lostBinding); got["status"] != "consumed" {
		t.Fatalf("lost token state: %v", got["status"])
	}
	if cutCount.Load() != 2 {
		t.Fatalf("wire cuts: %d", cutCount.Load())
	}
	deniedID, deniedBinding := start("denied-state")
	deniedPending := oauthHTTPPending(h, deniedID, deniedBinding.Value, "denied-state", "acceptance-client", redirect, "preregistered")
	deniedResponse, deniedBody, err := decision(deniedPending, deniedBinding, "deny")
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
	deniedRow := deniedPending
	deniedRow.Status = "denied"
	deniedRow.UserID = principal.UserID
	deniedRow.State = ""
	deniedRow.StatePresent = false
	deniedRow.RetainUntil = h.Now.Add(24 * time.Hour)
	if got := inspect(deniedRow, deniedBinding); got["status"] != "denied" {
		t.Fatalf("denial state: %v", got["status"])
	}
	if h.Rates["oauth:start:global"] != 4 || h.Rates["oauth:start:source:127.0.0.1"] != 4 {
		t.Fatalf("authorization start admission calls: %+v", h.Rates)
	}
}
