package auth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

type scopedPATIdentity struct {
	*strictIdentity
	catalog                             scopepolicy.CatalogSnapshot
	token                               model.PersonalAccessToken
	listCalls, createCalls, updateCalls int
	listErr, updateErr                  error
	disabled                            bool
}

type patListContextKey struct{}

func (s *scopedPATIdentity) DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	return s.catalog, !s.disabled
}
func (s *scopedPATIdentity) ListScopedPATs(ctx context.Context, principal model.Principal) ([]model.PersonalAccessToken, error) {
	want, _ := authRequestAccount(1)
	if principal != want || ctx.Value(patListContextKey{}) != "request" || ctx.Err() != nil {
		s.t.Fatalf("list identity/context: principal=%+v context error=%v", principal, ctx.Err())
	}
	if _, ok := ctx.Deadline(); !ok {
		s.t.Fatal("list context has no request deadline")
	}
	s.listCalls++
	return []model.PersonalAccessToken{s.token}, s.listErr
}
func (s *scopedPATIdentity) CreateScopedPAT(_ context.Context, p model.Principal, expected string, in identitycore.CreatePAT, description *string, revision string, ids []scopepolicy.ScopeID) (identitycore.MintedPAT, error) {
	s.createCalls++
	if p.UserID != expected || in.Name != "test" || revision != s.catalog.CatalogRevision || len(ids) != 1 || ids[0] != "task:read" {
		panic("bad create propagation")
	}
	return identitycore.MintedPAT{Credential: s.token, Secret: "secret"}, nil
}
func (s *scopedPATIdentity) UpdateScopedPAT(_ context.Context, p model.Principal, id, expected string, version int64, revision string, ids []scopepolicy.ScopeID) (model.PersonalAccessToken, error) {
	s.updateCalls++
	if p.UserID != expected || id != s.token.ID || version != 2 || revision != s.catalog.CatalogRevision || len(ids) != 1 || ids[0] != "task:read" {
		panic("bad patch propagation")
	}
	return s.token, s.updateErr
}

func TestScopedPATManagementHTTP(t *testing.T) {
	p, _ := authRequestAccount(1)
	catalog, _ := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"})
	policy, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 2)
	expired := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	description := "retained description"
	i := &scopedPATIdentity{strictIdentity: &strictIdentity{t: t, callback: func() string { return authRequestOrigin + "/auth/callback" }}, catalog: catalog,
		token: model.PersonalAccessToken{ID: "40000000-0000-4000-8000-000000000001", UserID: p.UserID, Name: "test", CreatedAt: expired, ExpiresAt: &expired, Description: &description, ScopePolicy: &policy}}
	i.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) { return p, nil }
	auth, err := NewAuthentication(i, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	registered := make(map[string]ScopeRoute)
	if err = auth.RegisterPATScopeRoutes(mux, func(route ScopeRoute) {
		if _, duplicate := registered[route.Pattern]; duplicate {
			t.Fatalf("duplicate scope route %s", route.Pattern)
		}
		registered[route.Pattern] = route
	}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		pattern  string
		fallback bool
	}{
		{"PATCH /api/v2/me/tokens/{tokenId}/scopes", false},
		{"/api/v2/me/tokens/{tokenId}/scopes", true},
	} {
		route, found := registered[tc.pattern]
		if !found || !route.BrowserOnly || route.Fallback != tc.fallback || route.SelfIntrospection || len(route.Operations) != 0 {
			t.Fatalf("scope classification %s: %+v", tc.pattern, route)
		}
		method := "PATCH"
		if tc.fallback {
			method = "DELETE"
		}
		r := httptest.NewRequest(method, "/api/v2/me/tokens/"+i.token.ID+"/scopes", nil)
		_, matched := mux.Handler(r)
		if matched != tc.pattern {
			t.Fatalf("%s matched %q, want %q", method, matched, tc.pattern)
		}
	}
	request := func(method, path, body string, origin bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r = r.WithContext(context.WithValue(r.Context(), patListContextKey{}, "request"))
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: authAliceCookie})
		if origin {
			r.Header.Set("Origin", authRequestOrigin)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	list := request("GET", "/api/v2/me/tokens", "", false)
	var page struct {
		Items []map[string]json.RawMessage `json:"items"`
	}
	if list.Code != 200 || json.Unmarshal(list.Body.Bytes(), &page) != nil || len(page.Items) != 1 || len(page.Items[0]) != 7 || string(page.Items[0]["description"]) != `"retained description"` || string(page.Items[0]["scopePolicy"]) != `{"scopes":["task:read"],"scopeVersion":"2"}` || string(page.Items[0]["expiresAt"]) == "null" || list.Header().Get("Cache-Control") != "no-store" || list.Header().Get("Daynight-User-ID") != p.UserID {
		t.Fatalf("list: %d %s", list.Code, list.Body)
	}
	body := `{"expectedUserId":"` + p.UserID + `","name":"test","expiresAt":null,"catalogRevision":"` + catalog.CatalogRevision + `","scopes":["task:read"]}`
	created := request("POST", "/api/v2/me/tokens", body, true)
	if created.Code != 201 || !strings.Contains(created.Body.String(), `"token":"secret"`) || !strings.Contains(created.Body.String(), `"scopeVersion":"2"`) {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	path := "/api/v2/me/tokens/" + i.token.ID + "/scopes"
	patch := `{"expectedUserId":"` + p.UserID + `","expectedScopeVersion":"2","catalogRevision":"` + catalog.CatalogRevision + `","scopes":["task:read"]}`
	for _, invalid := range []string{strings.Replace(patch, `"2"`, `2`, 1), strings.Replace(patch, `"2"`, `"02"`, 1), strings.Replace(patch, `["task:read"]`, `[]`, 1), strings.Replace(patch, `"2"`, `"9223372036854775808"`, 1)} {
		w := request("PATCH", path, invalid, true)
		if w.Code != 400 || i.updateCalls != 0 {
			t.Fatalf("invalid: %d %s", w.Code, w.Body)
		}
	}
	if w := request("PATCH", path, patch, false); w.Code != 403 || i.updateCalls != 0 {
		t.Fatalf("origin: %d", w.Code)
	}
	i.updateErr = &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: errors.New("lost confirmation")}
	w := request("PATCH", path, patch, true)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "write_outcome_unknown") || i.updateCalls != 1 {
		t.Fatalf("unknown: %d %s", w.Code, w.Body)
	}
	readback := request("GET", "/api/v2/me/tokens", "", false)
	if readback.Code != 200 || i.listCalls != 2 || i.updateCalls != 1 || !strings.Contains(readback.Body.String(), `"scopeVersion":"2"`) {
		t.Fatalf("readback: %d %s", readback.Code, readback.Body)
	}
	i.updateErr = &model.Fault{Code: "version_conflict", Message: "stale"}
	w = request("PATCH", path, patch, true)
	if w.Code != 409 || i.updateCalls != 2 {
		t.Fatalf("conflict: %d %s", w.Code, w.Body)
	}
}

func TestScopedPATListRejectsInvalidRequestsAndResults(t *testing.T) {
	p, _ := authRequestAccount(1)
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	mcpPolicy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	i := &scopedPATIdentity{strictIdentity: &strictIdentity{t: t, callback: func() string { return authRequestOrigin + "/auth/callback" }}, catalog: catalog}
	i.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) { return p, nil }
	auth, err := NewAuthentication(i, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := auth.RegisterPATScopeRoutes(mux, nil); err != nil {
		t.Fatal(err)
	}
	request := func(path, authorization string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r = r.WithContext(context.WithValue(r.Context(), patListContextKey{}, "request"))
		r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: authAliceCookie})
		if authorization != "" {
			r.Header.Set("Authorization", authorization)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := request("/api/v2/me/tokens?unexpected=1", ""); w.Code != 400 || i.listCalls != 0 {
		t.Fatalf("query refusal: %d calls=%d", w.Code, i.listCalls)
	}
	if w := request("/api/v2/me/tokens", "Bearer secret"); w.Code != 403 || i.listCalls != 0 {
		t.Fatalf("bearer refusal: %d calls=%d", w.Code, i.listCalls)
	}
	i.listErr = errors.New("private storage diagnostic")
	if w := request("/api/v2/me/tokens", ""); w.Code != 500 || strings.Contains(w.Body.String(), "private storage diagnostic") || i.listCalls != 1 {
		t.Fatalf("read failure: %d calls=%d body=%s", w.Code, i.listCalls, w.Body)
	}
	i.listErr = nil
	for index, policy := range []*scopepolicy.Policy{nil, &mcpPolicy} {
		i.token.ScopePolicy = policy
		w := request("/api/v2/me/tokens", "")
		if w.Code != 500 || i.listCalls != index+2 || strings.Contains(w.Body.String(), "scopePolicy") {
			t.Fatalf("invalid policy %d: status=%d calls=%d body=%s", index, w.Code, i.listCalls, w.Body)
		}
	}
}

func TestScopedAccountRegistration(t *testing.T) {
	p, _ := authRequestAccount(1)
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"account:write"})
	if err != nil {
		t.Fatal(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"account:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	legacy := &strictIdentity{t: t, callback: func() string { return authRequestOrigin + "/auth/callback" }}
	legacy.authenticate = func(context.Context, model.CredentialKind, string) (model.Principal, error) { return p, nil }
	valid := &scopedPATIdentity{strictIdentity: legacy, catalog: catalog, token: model.PersonalAccessToken{ScopePolicy: &policy}}
	disabled := &scopedPATIdentity{strictIdentity: legacy, disabled: true}
	scopedPrincipal := p
	scopedPrincipal.Kind = model.PATCredential
	scoped := &scopedProfileAuth{value: model.CredentialAuthorization{Principal: scopedPrincipal, Profile: model.ScopedPATProfile, Policy: &policy}}
	profile := &scopedProfileFixture{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name     string
		identity identityOperations
		scoped   ScopedAuthentication
		profile  ScopedProfile
	}{
		{"missing auth", valid, nil, profile},
		{"missing profile", valid, scoped, nil},
		{"legacy identity", legacy, scoped, profile},
		{"disabled catalog", disabled, scoped, profile},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, err := NewAuthentication(tc.identity, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, logger)
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			observed := false
			if err := h.RegisterScopedAccountRoutes(mux, tc.scoped, tc.profile, nil, func(ScopeRoute) { observed = true }); err == nil || observed {
				t.Fatalf("registration error=%v observed=%v", err, observed)
			}
			_, pattern := mux.Handler(httptest.NewRequest("PATCH", "/api/v1/me", nil))
			if pattern != "" {
				t.Fatalf("refused registration exposed %s", pattern)
			}
		})
	}
	for _, i := range []identityOperations{legacy, disabled} {
		h, err := NewAuthentication(i, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, logger)
		if err != nil {
			t.Fatal(err)
		}
		if err := h.RegisterPATScopeRoutes(http.NewServeMux(), nil); err == nil {
			t.Fatal("PAT registration accepted unavailable scope capability")
		}
	}
	h, err := NewAuthentication(valid, authconfig.AuthSettings{PublicOrigin: authRequestOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	recheck := func(_ context.Context, _ store.IdentityScope, principal model.Principal) (model.CredentialAuthorization, error) {
		if principal != scopedPrincipal {
			t.Fatal("wrong recheck principal")
		}
		return scoped.value, nil
	}
	if err := h.RegisterScopedAccountRoutes(mux, scoped, profile, recheck, nil); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("PATCH", "/api/v1/me", strings.NewReader(`{"name":"Alice"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 200 || profile.calls != 1 || !profile.checked {
		t.Fatalf("profile route: %d calls=%d checked=%v body=%s", w.Code, profile.calls, profile.checked, w.Body)
	}
	r = httptest.NewRequest("GET", "/api/v2/me/tokens", nil)
	r = r.WithContext(context.WithValue(r.Context(), patListContextKey{}, "request"))
	r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: authAliceCookie})
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 200 || valid.listCalls != 1 || !strings.Contains(w.Body.String(), `"scopeVersion":"1"`) {
		t.Fatalf("PAT route: %d calls=%d body=%s", w.Code, valid.listCalls, w.Body)
	}
}
