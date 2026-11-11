package authorization

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

const testRequestID = "0c0fa810-54e5-4800-9d5e-a4dfc2346b52"
const testUserID = "3e4b79a7-f017-4a9f-950d-04413f1374aa"

type browserAuth struct {
	principal model.Principal
	err       error
}

func (a browserAuth) Origin() string { return "https://daynight.example" }
func (a browserAuth) AuthenticateRequest(*http.Request) (model.Principal, error) {
	return a.principal, a.err
}

type authorizationsStub struct {
	starts      []service.StartInput
	inspections int
	decisions   []service.DecisionInput
	redeems     []service.RedeemInput
	err         error
}

func (s *authorizationsStub) Start(_ context.Context, in service.StartInput) (service.StartResult, error) {
	s.starts = append(s.starts, in)
	return service.StartResult{RequestID: testRequestID, Binding: "binding-secret"}, s.err
}
func (s *authorizationsStub) Inspect(_ context.Context, _, _ string, _ model.Principal) (service.AuthorizationView, error) {
	s.inspections++
	return service.AuthorizationView{RequestID: testRequestID, Status: "approved"}, s.err
}
func (s *authorizationsStub) Decide(_ context.Context, in service.DecisionInput) (service.DecisionResult, error) {
	s.decisions = append(s.decisions, in)
	return service.DecisionResult{RedirectURI: "https://client.example/cb?code=secret&iss=https%3A%2F%2Fdaynight.example"}, s.err
}
func (s *authorizationsStub) RedeemCode(_ context.Context, in service.RedeemInput) (service.TokenResult, error) {
	s.redeems = append(s.redeems, in)
	return service.TokenResult{AccessToken: "access-secret", RefreshToken: "refresh-secret", TokenType: "Bearer", ExpiresIn: 3600, Scope: core.Scope}, s.err
}

func TestAuthorizationBrowserHTTPBoundRequests(t *testing.T) {
	svc := &authorizationsStub{}
	auth := browserAuth{principal: model.Principal{Kind: model.SessionCredential, UserID: testUserID, CredentialID: testRequestID}}
	h := NewAuthorizationHTTP(svc, auth)
	q := url.Values{"client_id": {"client"}, "redirect_uri": {"https://client.example/cb"}, "response_type": {"code"}, "scope": {core.Scope}, "resource": {"https://daynight.example/mcp"}, "state": {"opaque"}, "code_challenge": {"challenge"}, "code_challenge_method": {"S256"}}
	r := httptest.NewRequest("GET", "/oauth/authorize?"+q.Encode(), nil)
	r.RemoteAddr = "192.0.2.1:1234"
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	w := httptest.NewRecorder()
	h.Start(w, r)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/oauth/consent?request="+testRequestID || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("start: %d %v", w.Code, w.Header())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode || !strings.HasPrefix(cookies[0].Name, "__Host-") || cookies[0].Path != "/" || cookies[0].Value != "binding-secret" {
		t.Fatalf("cookie: %+v", cookies)
	}
	if len(svc.starts) != 1 || svc.starts[0].Source != "192.0.2.1" {
		t.Fatalf("source: %+v", svc.starts)
	}
	if h.cookieName(testRequestID) == h.cookieName(testUserID) {
		t.Fatal("request cookies collide")
	}

	makeDecision := func(origin string, cookie *http.Cookie, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/v1/oauth/requests/"+testRequestID+"/decision", strings.NewReader(body))
		r.SetPathValue("id", testRequestID)
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "application/json")
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.Decide(w, r)
		return w
	}
	body := `{"expectedUserId":"` + testUserID + `","decision":"approve"}`
	if got := makeDecision("https://evil.example", cookies[0], body); got.Code != http.StatusForbidden || len(svc.decisions) != 0 {
		t.Fatalf("bad origin: %d", got.Code)
	}
	if got := makeDecision(auth.Origin(), nil, body); got.Code != http.StatusNotFound || len(svc.decisions) != 0 {
		t.Fatalf("missing binding: %d", got.Code)
	}
	if got := makeDecision(auth.Origin(), cookies[0], `{"expectedUserId":"`+testUserID+`","decision":"approve","decision":"deny"}`); got.Code != http.StatusBadRequest || len(svc.decisions) != 0 {
		t.Fatalf("duplicate JSON: %d", got.Code)
	}
	got := makeDecision(auth.Origin(), cookies[0], body)
	if got.Code != http.StatusOK || len(svc.decisions) != 1 || svc.decisions[0].Binding != "binding-secret" || svc.decisions[0].Principal.UserID != testUserID || svc.decisions[0].ExpectedUserID != testUserID || !strings.Contains(got.Body.String(), "redirectUri") {
		t.Fatalf("decision: %d %s %+v", got.Code, got.Body, svc.decisions)
	}
	if got.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("decision response is cacheable")
	}

	r = httptest.NewRequest("GET", "/api/v1/oauth/requests/"+testRequestID, nil)
	r.SetPathValue("id", testRequestID)
	r.AddCookie(cookies[0])
	w = httptest.NewRecorder()
	h.Inspect(w, r)
	var view map[string]any
	err := json.Unmarshal(w.Body.Bytes(), &view)
	_, hasCode := view["code"]
	if err != nil || w.Code != http.StatusOK || svc.inspections != 1 || strings.Contains(w.Body.String(), "binding-secret") || hasCode {
		t.Fatalf("inspect: %d %s", w.Code, w.Body)
	}
	h.auth = browserAuth{principal: model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testRequestID}}
	w = httptest.NewRecorder()
	h.Inspect(w, r)
	if w.Code != http.StatusUnauthorized || svc.inspections != 1 {
		t.Fatalf("PAT: %d", w.Code)
	}
}

func TestAuthorizationSessionFailureDoesNotMasqueradeAsLogout(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{err: errors.New("private database failure")})
	r := httptest.NewRequest("GET", "/api/v1/oauth/requests/"+testRequestID, nil)
	r.SetPathValue("id", testRequestID)
	w := httptest.NewRecorder()
	h.Inspect(w, r)
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "private database failure") || svc.inspections != 0 {
		t.Fatalf("session failure: %d %s", w.Code, w.Body)
	}
	h.auth = browserAuth{err: model.Unauthenticated(nil)}
	w = httptest.NewRecorder()
	h.Inspect(w, r)
	if w.Code != http.StatusUnauthorized || svc.inspections != 0 {
		t.Fatalf("missing session: %d %s", w.Code, w.Body)
	}
}

func TestAuthorizationHTTPRejectsMalformedRequests(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{})
	for _, query := range []string{"client_id=a&client_id=b", "client_id=%ff", "client_id=%00", "client_id=%zz", "unrecognized=x"} {
		w := httptest.NewRecorder()
		h.Start(w, httptest.NewRequest("GET", "/oauth/authorize?"+query, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("query %q: %d", query, w.Code)
		}
	}
	if len(svc.starts) != 0 {
		t.Fatal("malformed request reached service")
	}
	svc.err = core.ErrRateLimited
	w := httptest.NewRecorder()
	h.Start(w, httptest.NewRequest("GET", "/oauth/authorize?client_id=a", nil))
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "60" || w.Header().Get("Location") != "" {
		t.Fatalf("rate limit: %d %v", w.Code, w.Header())
	}
	svc.err = errors.New("private details")
	w = httptest.NewRecorder()
	h.Start(w, httptest.NewRequest("GET", "/oauth/authorize?client_id=a", nil))
	if w.Code != http.StatusInternalServerError || strings.Contains(w.Body.String(), "private details") || w.Header().Get("Location") != "" {
		t.Fatalf("safe error: %d %s", w.Code, w.Body)
	}
}

func TestRedeemHTTPFormAndSecretBoundaries(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{})
	request := func(form string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader(form))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.RedeemCode(w, r)
		return w
	}
	for _, form := range []string{"grant_type=authorization_code&code=x&code=y", "grant_type=authorization_code&code=%ff", "grant_type=refresh_token", "grant_type=authorization_code&extra=x"} {
		w := request(form)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("form %q: %d", form, w.Code)
		}
	}
	if len(svc.redeems) != 0 {
		t.Fatal("malformed form reached service")
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {"code-secret"}, "client_id": {"client"}, "redirect_uri": {"https://client.example/cb"}, "resource": {"https://daynight.example/mcp"}, "code_verifier": {"verifier"}}.Encode()
	w := request(form)
	var response map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(svc.redeems) != 1 || svc.redeems[0].Verifier != "verifier" || response["access_token"] != "access-secret" || response["refresh_token"] != "refresh-secret" || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("redeem: %d %v", w.Code, response)
	}
}

func TestStartPreservesEmptyAndAbsentState(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{})
	for _, query := range []string{"client_id=client&state=", "client_id=client"} {
		w := httptest.NewRecorder()
		h.Start(w, httptest.NewRequest("GET", "/oauth/authorize?"+query, nil))
		if w.Code != http.StatusSeeOther {
			t.Fatalf("%q: %d", query, w.Code)
		}
	}
	if len(svc.starts) != 2 || !svc.starts[0].StatePresent || svc.starts[0].State != "" || svc.starts[1].StatePresent {
		t.Fatalf("state inputs: %+v", svc.starts)
	}
}

type invalidStartService struct{ authorizationsStub }

func (*invalidStartService) Start(context.Context, service.StartInput) (service.StartResult, error) {
	return service.StartResult{RequestID: "invalid", Binding: "secret"}, nil
}

func TestStartRejectsInvalidMethodAndUnconfirmedResult(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{})
	w := httptest.NewRecorder()
	h.Start(w, httptest.NewRequest(http.MethodPost, "/oauth/authorize", nil))
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET" || len(svc.starts) != 0 {
		t.Fatalf("method: %d %v", w.Code, w.Header())
	}
	w = httptest.NewRecorder()
	h.Start(w, httptest.NewRequest(http.MethodGet, "/oauth/authorize?client_id="+strings.Repeat("a", core.MetadataLimit), nil))
	if w.Code != http.StatusBadRequest || len(svc.starts) != 0 {
		t.Fatalf("oversized query: %d", w.Code)
	}
	r := httptest.NewRequest(http.MethodGet, "/oauth/authorize?client_id=a", nil)
	r.RemoteAddr = "192.0.2.1"
	w = httptest.NewRecorder()
	h.Start(w, r)
	if w.Code != http.StatusSeeOther || svc.starts[0].Source != "192.0.2.1" {
		t.Fatalf("remote address: %d %+v", w.Code, svc.starts)
	}
	h.service = &invalidStartService{}
	w = httptest.NewRecorder()
	h.Start(w, r)
	if w.Code != http.StatusInternalServerError || w.Header().Get("Location") != "" || len(w.Result().Cookies()) != 0 {
		t.Fatalf("invalid result: %d %v", w.Code, w.Header())
	}
}

func TestBrowserAuthorizationRejections(t *testing.T) {
	svc := &authorizationsStub{}
	auth := browserAuth{principal: model.Principal{Kind: model.SessionCredential, UserID: testUserID, CredentialID: testRequestID}}
	h := NewAuthorizationHTTP(svc, auth)
	cookie := &http.Cookie{Name: h.cookieName(testRequestID), Value: "binding-secret"}
	request := func(method, path, body string, binding bool) *http.Request {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.SetPathValue("id", testRequestID)
		r.Header.Set("Origin", auth.Origin())
		r.Header.Set("Content-Type", "application/json")
		if binding {
			r.AddCookie(cookie)
		}
		return r
	}
	for _, tc := range []struct {
		method, path string
		binding      bool
		status       int
	}{
		{"POST", "/api/v1/oauth/requests/x", true, http.StatusMethodNotAllowed},
		{"GET", "/api/v1/oauth/requests/x?unexpected=1", true, http.StatusBadRequest},
		{"GET", "/api/v1/oauth/requests/x", false, http.StatusNotFound},
	} {
		w := httptest.NewRecorder()
		h.Inspect(w, request(tc.method, tc.path, "", tc.binding))
		if w.Code != tc.status || svc.inspections != 0 {
			t.Fatalf("inspect %+v: %d", tc, w.Code)
		}
	}
	svc.err = core.ErrAuthorizationUnknown
	w := httptest.NewRecorder()
	h.Inspect(w, request("GET", "/api/v1/oauth/requests/x", "", true))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "outcome_unknown") {
		t.Fatalf("inspect failure: %d %s", w.Code, w.Body)
	}
	svc.err = nil
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/api/v1/oauth/requests/x/decision", "", http.StatusMethodNotAllowed},
		{"POST", "/api/v1/oauth/requests/x/decision?unexpected=1", "{}", http.StatusBadRequest},
		{"POST", "/api/v1/oauth/requests/x/decision", `{"decision":"approve"}`, http.StatusBadRequest},
		{"POST", "/api/v1/oauth/requests/x/decision", `{"expectedUserId":"` + testUserID + `"}`, http.StatusBadRequest},
		{"POST", "/api/v1/oauth/requests/x/decision", `{"expectedUserId":"` + testUserID + `","decision":"other"}`, http.StatusBadRequest},
	} {
		w := httptest.NewRecorder()
		h.Decide(w, request(tc.method, tc.path, tc.body, true))
		if w.Code != tc.status || len(svc.decisions) != 0 {
			t.Fatalf("decide %+v: %d", tc, w.Code)
		}
	}
	svc.err = core.ErrInvalidAuthorization
	w = httptest.NewRecorder()
	h.Decide(w, request("POST", "/api/v1/oauth/requests/x/decision", `{"expectedUserId":"`+testUserID+`","decision":"deny"}`, true))
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "invalid_request") || len(svc.decisions) != 1 {
		t.Fatalf("decision failure: %d %s", w.Code, w.Body)
	}
}

func TestRedeemHTTPRejectionsAndPreflight(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{})
	for _, tc := range []struct {
		method, target, media, body string
		status                      int
	}{
		{"OPTIONS", "/oauth/token", "", "", http.StatusNoContent},
		{"GET", "/oauth/token", "", "", http.StatusMethodNotAllowed},
		{"POST", "/oauth/token?code=secret", "application/x-www-form-urlencoded", "", http.StatusBadRequest},
		{"POST", "/oauth/token", "application/json", "{}", http.StatusBadRequest},
		{"POST", "/oauth/token", "application/x-www-form-urlencoded; charset=ascii", "grant_type=authorization_code", http.StatusBadRequest},
		{"POST", "/oauth/token", "application/x-www-form-urlencoded", strings.Repeat("a", core.MetadataLimit+1), http.StatusRequestEntityTooLarge},
	} {
		r := httptest.NewRequest(tc.method, tc.target, strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.media)
		w := httptest.NewRecorder()
		h.RedeemCode(w, r)
		if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Access-Control-Allow-Origin") != "*" || len(svc.redeems) != 0 {
			t.Fatalf("token %+v: %d", tc, w.Code)
		}
		if tc.method == "OPTIONS" && (w.Header().Get("Access-Control-Allow-Methods") != "POST, OPTIONS" || w.Header().Get("Access-Control-Allow-Headers") != "Content-Type") {
			t.Fatalf("preflight: %v", w.Header())
		}
	}
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{model.Unauthenticated(nil), http.StatusUnauthorized, "unauthorized"},
		{core.ErrInvalidClient, http.StatusBadRequest, "invalid_client"},
		{core.ErrInvalidAuthorization, http.StatusBadRequest, "invalid_request"},
		{core.ErrInvalidGrant, http.StatusBadRequest, "invalid_grant"},
		{core.ErrAuthorizationCapacity, http.StatusServiceUnavailable, "temporarily_unavailable"},
		{core.ErrAuthorizationUnknown, http.StatusServiceUnavailable, "outcome_unknown"},
	} {
		svc.err = tc.err
		r := httptest.NewRequest("POST", "/oauth/token", strings.NewReader("grant_type=authorization_code&code=secret"))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		w := httptest.NewRecorder()
		h.RedeemCode(w, r)
		var result map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != tc.status || result["error"] != tc.code || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("%v: %d %s", tc.err, w.Code, w.Body)
		}
	}
}

func TestStartInvalidBrowserRequestUsesLocalErrorPage(t *testing.T) {
	svc := &authorizationsStub{}
	h := NewAuthorizationHTTP(svc, browserAuth{})
	h.SetStartErrorPage(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("local shell"))
	}))
	for _, tc := range []struct {
		query   string
		failure error
		code    string
	}{
		{"client_id=a&client_id=b", nil, "invalid_request"},
		{"client_id=bad&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback", core.ErrInvalidClient, "invalid_client"},
		{"client_id=valid&redirect_uri=https%3A%2F%2Fevil.example%2Fcallback", core.ErrInvalidAuthorization, "invalid_request"},
	} {
		svc.err = tc.failure
		r := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+tc.query, nil)
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w := httptest.NewRecorder()
		h.Start(w, r)
		if w.Code != http.StatusBadRequest || w.Body.String() != "local shell" || w.Header().Get("X-OAuth-Error") != tc.code || w.Header().Get("Location") != "" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("browser error: %d %v %s", w.Code, w.Header(), w.Body)
		}
		r.Header.Set("Accept", "application/json")
		w = httptest.NewRecorder()
		h.Start(w, r)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), `"error":"`+tc.code+`"`) || w.Header().Get("Location") != "" {
			t.Fatalf("protocol error: %d %v %s", w.Code, w.Header(), w.Body)
		}
	}
}

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
	adapter := NewAuthorizationHTTP(service, h.Auth)
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
			oauthHTTPExpectRedeem(t, h, approved, true, &unused)
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
	oauthHTTPExpectRedeem(t, h, lostApproved, false, &lostIssue)
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
