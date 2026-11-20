package authorization

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
)

type scopedAuthorizationsStub struct {
	authorizationsStub
	enabled bool
	inspect func(context.Context, string, string, model.Principal) (service.AuthorizationViewV2, error)
	decide  func(context.Context, service.ScopedDecisionInput) (service.DecisionResult, error)
}

func (s *scopedAuthorizationsStub) ScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	return scopepolicy.CatalogSnapshot{}, s.enabled
}
func (s *scopedAuthorizationsStub) InspectV2(ctx context.Context, id, binding string, p model.Principal) (service.AuthorizationViewV2, error) {
	return s.inspect(ctx, id, binding, p)
}
func (s *scopedAuthorizationsStub) DecideV2(ctx context.Context, in service.ScopedDecisionInput) (service.DecisionResult, error) {
	return s.decide(ctx, in)
}

type scopedBrowserAuth struct {
	browserAuth
	calls int
}

func (a *scopedBrowserAuth) AuthenticateSessionRequest(r *http.Request) (model.Principal, error) {
	a.calls++
	return a.AuthenticateRequest(r)
}

func scopedHTTPFixture(t *testing.T) (*AuthorizationHTTP, *scopedAuthorizationsStub, *scopedBrowserAuth, *http.ServeMux) {
	t.Helper()
	svc := &scopedAuthorizationsStub{enabled: true}
	svc.inspect = func(context.Context, string, string, model.Principal) (service.AuthorizationViewV2, error) {
		t.Fatal("unexpected inspection")
		return service.AuthorizationViewV2{}, nil
	}
	svc.decide = func(context.Context, service.ScopedDecisionInput) (service.DecisionResult, error) {
		t.Fatal("unexpected decision")
		return service.DecisionResult{}, nil
	}
	auth := &scopedBrowserAuth{browserAuth: browserAuth{principal: model.Principal{Kind: model.SessionCredential, UserID: testUserID, CredentialID: testRequestID}}}
	h := NewAuthorizationHTTP(svc, auth)
	mux := http.NewServeMux()
	if err := h.RegisterScopedRoutes(mux); err != nil {
		t.Fatal(err)
	}
	return h, svc, auth, mux
}

func scopedHTTPRequest(h *AuthorizationHTTP, method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Origin", h.auth.Origin())
	r.Header.Set("Content-Type", "application/json")
	r.AddCookie(&http.Cookie{Name: h.cookieName(testRequestID), Value: "same-v1-binding"})
	return r
}

func TestScopedRoutesRequireScopedIssuerAndBrowserAdmission(t *testing.T) {
	auth := &scopedBrowserAuth{}
	for _, svc := range []AuthorizationService{&authorizationsStub{}, &scopedAuthorizationsStub{enabled: false}} {
		mux := http.NewServeMux()
		if err := NewAuthorizationHTTP(svc, auth).RegisterScopedRoutes(mux); err == nil {
			t.Fatal("registered without scoped issuer")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("GET", "/api/v2/oauth/requests/"+testRequestID, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("partially registered: %d", w.Code)
		}
	}
	if err := NewAuthorizationHTTP(&scopedAuthorizationsStub{enabled: true}, browserAuth{}).RegisterScopedRoutes(http.NewServeMux()); err == nil {
		t.Fatal("registered without session-only admission")
	}
}

func TestScopedRoutesReadAndDecideWithOriginalBinding(t *testing.T) {
	h, svc, auth, mux := scopedHTTPFixture(t)
	revision := "revision"
	svc.inspect = func(ctx context.Context, id, binding string, p model.Principal) (service.AuthorizationViewV2, error) {
		if _, ok := ctx.Deadline(); !ok || id != testRequestID || binding != "same-v1-binding" || p != auth.principal {
			t.Fatalf("inspection inputs: %s %s %+v", id, binding, p)
		}
		return service.AuthorizationViewV2{AuthorizationView: service.AuthorizationView{RequestID: id, Status: "pending", Scope: core.Scope, UserID: p.UserID}, CatalogRevision: &revision}, nil
	}
	var got service.ScopedDecisionInput
	svc.decide = func(ctx context.Context, in service.ScopedDecisionInput) (service.DecisionResult, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("missing decision deadline")
		}
		got = in
		return service.DecisionResult{RedirectURI: "https://client.example/cb?code=once"}, nil
	}
	path := "/api/v2/oauth/requests/" + testRequestID
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, scopedHTTPRequest(h, "GET", path, ""))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"catalogRevision":"revision"`) || !strings.Contains(w.Body.String(), `"scope":"daynight:mcp"`) || strings.Contains(w.Body.String(), "binding") {
		t.Fatalf("inspection: %d %s", w.Code, w.Body)
	}
	body := `{"expectedUserId":"` + testUserID + `","decision":"approve","catalogRevision":"revision","scopes":["task:read"]}`
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, scopedHTTPRequest(h, "POST", path+"/decision", body))
	if w.Code != 200 || w.Body.String() != "{\"redirectUri\":\"https://client.example/cb?code=once\"}\n" || got.RequestID != testRequestID || got.Binding != "same-v1-binding" || got.Principal != auth.principal || got.ExpectedUserID != testUserID || got.CatalogRevision != revision || !reflect.DeepEqual(got.Scopes, []scopepolicy.ScopeID{"task:read"}) {
		t.Fatalf("decision: %d %s %+v", w.Code, w.Body, got)
	}
	if w.Header().Get("Daynight-User-ID") != testUserID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("account headers: %v", w.Header())
	}
	body = `{"expectedUserId":"` + testUserID + `","decision":"deny"}`
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, scopedHTTPRequest(h, "POST", path+"/decision", body))
	if w.Code != 200 || got.Decision != "deny" || got.CatalogRevision != "" || got.Scopes != nil {
		t.Fatalf("denial: %d %+v", w.Code, got)
	}
}

func TestScopedDecisionRejectsMalformedInputsBeforeBusinessCall(t *testing.T) {
	h, _, _, mux := scopedHTTPFixture(t)
	base := `"expectedUserId":"` + testUserID + `","decision":"approve"`
	for _, body := range []string{
		`{` + base + `}`, `{` + base + `,"catalogRevision":"r"}`, `{` + base + `,"catalogRevision":"r","scopes":[]}`, `{` + base + `,"catalogRevision":"r","scopes":null}`, `{` + base + `,"catalogRevision":"","scopes":["task:read"]}`, `{` + base + `,"catalogRevision":"r","scopes":[1]}`, `{` + base + `,"catalogRevision":"r","scopes":["\ud800"]}`, `{` + base + `,"decision":"deny"}`, `{` + base + `,"extra":true}`, `{"expectedUserId":"` + testUserID + `","decision":"deny","scopes":null}`, `{"expectedUserId":"` + testUserID + `","decision":"deny","catalogRevision":"r"}`, `{"expectedUserId":"bad","decision":"deny"}`, `{"expectedUserId":"` + testUserID + `","decision":"invalid"}`,
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, scopedHTTPRequest(h, "POST", "/api/v2/oauth/requests/"+testRequestID+"/decision", body))
		if w.Code != 400 || !strings.Contains(w.Body.String(), `"code":"invalid_input"`) {
			t.Fatalf("body %s: %d %s", body, w.Code, w.Body)
		}
	}
}

func TestScopedRoutesEnforceAuthenticationBindingAndMethods(t *testing.T) {
	h, svc, auth, mux := scopedHTTPFixture(t)
	path := "/api/v2/oauth/requests/" + testRequestID
	body := `{"expectedUserId":"` + testUserID + `","decision":"deny"}`
	for _, tc := range []struct {
		name, method, path string
		mutate             func(*http.Request)
		status             int
	}{
		{"head", "HEAD", path, nil, 405}, {"inspect post", "POST", path, nil, 405}, {"decision get", "GET", path + "/decision", nil, 405}, {"inspect query", "GET", path + "?", nil, 400}, {"decision query", "POST", path + "/decision?", nil, 400},
		{"missing cookie", "GET", path, func(r *http.Request) { r.Header.Del("Cookie") }, 404},
		{"duplicate cookie", "GET", path, func(r *http.Request) { r.AddCookie(&http.Cookie{Name: h.cookieName(testRequestID), Value: "second"}) }, 404},
		{"bad origin", "POST", path + "/decision", func(r *http.Request) { r.Header.Set("Origin", "https://evil.example") }, 403},
		{"duplicate origin", "POST", path + "/decision", func(r *http.Request) { r.Header.Add("Origin", h.auth.Origin()) }, 403},
		{"bearer", "GET", path, func(r *http.Request) { r.Header.Set("Authorization", "Bearer secret") }, 403},
		{"other account", "POST", path + "/decision", func(r *http.Request) {
			r.Body = http.NoBody
			r.Body = io.NopCloser(strings.NewReader(`{"expectedUserId":"` + testRequestID + `","decision":"deny"}`))
		}, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := scopedHTTPRequest(h, tc.method, tc.path, body)
			if tc.mutate != nil {
				tc.mutate(r)
			}
			calls := auth.calls
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
			if tc.name == "bearer" && auth.calls != calls {
				t.Fatal("bearer reached authentication")
			}
		})
	}
	for _, p := range []model.Principal{{}, {Kind: model.PATCredential, UserID: testUserID, CredentialID: testRequestID}} {
		auth.principal = p
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, scopedHTTPRequest(h, "GET", path, ""))
		if w.Code != 401 {
			t.Fatalf("principal %+v: %d", p, w.Code)
		}
	}
	auth.principal = model.Principal{Kind: model.SessionCredential, UserID: testUserID, CredentialID: testRequestID}
	auth.err = errors.New("private auth failure")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, scopedHTTPRequest(h, "GET", path, ""))
	if w.Code != 500 || strings.Contains(w.Body.String(), "private auth") {
		t.Fatalf("auth failure: %d %s", w.Code, w.Body)
	}
	_ = svc
}

func TestScopedRoutesMapConflictsAndUnknownWithoutRetry(t *testing.T) {
	h, svc, _, mux := scopedHTTPFixture(t)
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "version_conflict", Message: "Review the catalog."}, 409, "version_conflict"},
		{&model.Fault{Code: "invalid_input", Message: "Invalid scopes."}, 400, "invalid_input"},
		{core.ErrInvalidAuthorization, 400, "invalid_input"}, {core.ErrRateLimited, 429, "rate_limited"},
		{core.ErrAuthorizationUnknown, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("private commit")}, 503, "write_outcome_unknown"},
		{errors.New("private database"), 500, "internal_error"},
	} {
		calls := 0
		svc.decide = func(context.Context, service.ScopedDecisionInput) (service.DecisionResult, error) {
			calls++
			return service.DecisionResult{RedirectURI: "https://client.example/cb?code=secret"}, tc.err
		}
		r := scopedHTTPRequest(h, "POST", "/api/v2/oauth/requests/"+testRequestID+"/decision", `{"expectedUserId":"`+testUserID+`","decision":"deny"}`)
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) || calls != 1 || strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("%v: %d %s calls %d", tc.err, w.Code, w.Body, calls)
		}
	}
}

func TestScopedRouteObservationAndReadErrors(t *testing.T) {
	h, svc, _, _ := scopedHTTPFixture(t)
	var observed []ScopeRoute
	mux := http.NewServeMux()
	if err := h.RegisterScopedRoutesWithScopeObserver(mux, func(route ScopeRoute) { observed = append(observed, route) }); err != nil {
		t.Fatal(err)
	}
	want := []ScopeRoute{
		{Pattern: "GET /api/v2/oauth/requests/{id}", BrowserOnly: true},
		{Pattern: "HEAD /api/v2/oauth/requests/{id}", BrowserOnly: true, Fallback: true},
		{Pattern: "/api/v2/oauth/requests/{id}", BrowserOnly: true, Fallback: true},
		{Pattern: "POST /api/v2/oauth/requests/{id}/decision", BrowserOnly: true},
		{Pattern: "/api/v2/oauth/requests/{id}/decision", BrowserOnly: true, Fallback: true},
	}
	if !reflect.DeepEqual(observed, want) {
		t.Fatalf("routes: %+v", observed)
	}
	svc.inspect = func(context.Context, string, string, model.Principal) (service.AuthorizationViewV2, error) {
		return service.AuthorizationViewV2{}, core.ErrInvalidAuthorization
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, scopedHTTPRequest(h, "GET", "/api/v2/oauth/requests/"+testRequestID, ""))
	if w.Code != 400 || !strings.Contains(w.Body.String(), `"code":"invalid_input"`) {
		t.Fatalf("read refusal: %d %s", w.Code, w.Body)
	}
	svc.inspect = func(context.Context, string, string, model.Principal) (service.AuthorizationViewV2, error) {
		return service.AuthorizationViewV2{AuthorizationView: service.AuthorizationView{RequestID: testRequestID, Status: "consumed"}}, nil
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, scopedHTTPRequest(h, "GET", "/api/v2/oauth/requests/"+testRequestID, ""))
	if w.Code != 200 || strings.Contains(w.Body.String(), "catalogRevision") {
		t.Fatalf("terminal view: %d %s", w.Code, w.Body)
	}
}

func TestScopedRoutesPropagateRequestCancellation(t *testing.T) {
	h, svc, _, mux := scopedHTTPFixture(t)
	key := struct{}{}
	for _, decision := range []bool{false, true} {
		started := make(chan struct{})
		returned := make(chan struct{})
		wait := func(ctx context.Context) error {
			if ctx.Value(key) != "request" {
				t.Error("request context lost")
			}
			close(started)
			<-ctx.Done()
			return ctx.Err()
		}
		svc.inspect = func(ctx context.Context, _ string, _ string, _ model.Principal) (service.AuthorizationViewV2, error) {
			return service.AuthorizationViewV2{}, wait(ctx)
		}
		svc.decide = func(ctx context.Context, _ service.ScopedDecisionInput) (service.DecisionResult, error) {
			return service.DecisionResult{}, wait(ctx)
		}
		method, path, body := "GET", "/api/v2/oauth/requests/"+testRequestID, ""
		if decision {
			method, path, body = "POST", path+"/decision", `{"expectedUserId":"`+testUserID+`","decision":"deny"}`
		}
		ctx, cancel := context.WithCancel(context.WithValue(context.Background(), key, "request"))
		r := scopedHTTPRequest(h, method, path, body).WithContext(ctx)
		go func() { defer close(returned); mux.ServeHTTP(httptest.NewRecorder(), r) }()
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			cancel()
			t.Fatal("operation did not start")
		}
		cancel()
		select {
		case <-returned:
		case <-time.After(5 * time.Second):
			t.Fatal("operation did not stop")
		}
	}
}
