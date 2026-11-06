package authorization

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
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
		{"POST", "/oauth/token", "application/x-www-form-urlencoded", strings.Repeat("a", core.MetadataLimit+1), http.StatusBadRequest},
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
