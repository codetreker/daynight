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
