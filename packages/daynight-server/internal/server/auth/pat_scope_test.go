package auth

import (
	"context"
	"encoding/json"
	"errors"
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
	updateErr                           error
}

func (s *scopedPATIdentity) DeviceScopeCatalog() (scopepolicy.CatalogSnapshot, bool) {
	return s.catalog, true
}
func (s *scopedPATIdentity) ListScopedPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error) {
	s.listCalls++
	return []model.PersonalAccessToken{s.token}, nil
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
