package github

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

var _ ScopedReaderOperations = (*core.Reader)(nil)
var _ ScopedAppsOperations = (*service.AppManager)(nil)
var _ ScopedConfigOperations = (*service.ConfigManager)(nil)
var _ ScopedProjectOperations = (*service.ProjectAppManager)(nil)
var _ ScopedAdminOperations = (*service.AdminManager)(nil)
var _ ScopedGrantsOperations = (*service.GrantManager)(nil)

type githubScopeAuth struct{ value model.CredentialAuthorization }

func (a *githubScopeAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.value) }
}

type githubScopeReader struct {
	ScopedReaderOperations
	calls int
	auth  model.CredentialAuthorization
	id    string
	input core.ListRequest
}

func (s *githubScopeReader) ListAuthorized(_ context.Context, a model.CredentialAuthorization, id string, input core.ListRequest) (core.Page, error) {
	s.calls++
	s.auth = a
	s.id = id
	s.input = input
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return core.Page{}, err
	}
	return core.Page{Connection: githubpr.Connection{ProjectID: id}}, nil
}
func TestScopedGitHubHTTPPassesAuthorizationAndRegistersFallback(t *testing.T) {
	policy, e := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"github:read"}, 1)
	if e != nil {
		t.Fatal(e)
	}
	auth := &githubScopeAuth{value: model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.ScopedPATProfile, Policy: &policy}}
	reader := &githubScopeReader{}
	mux := http.NewServeMux()
	routes := NewRouteRegistry(mux, nil)
	RegisterScopedPullRequestRoutes(routes, reader, auth, slog.New(slog.NewTextHandler(io.Discard, nil)))
	path := "/api/v1/projects/33333333-3333-4333-8333-333333333333/pull-requests?limit=5"
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 403 || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || reader.calls != 1 || reader.auth.Policy != auth.value.Policy || reader.auth.Principal != auth.value.Principal || reader.id != "33333333-3333-4333-8333-333333333333" || reader.input.Limit != 5 {
		t.Fatalf("denial: %d %v calls=%d", w.Code, w.Header(), reader.calls)
	}
	policy, e = scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read"}, 1)
	if e != nil {
		t.Fatal(e)
	}
	auth.value.Policy = &policy
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 200 || reader.calls != 2 {
		t.Fatalf("success %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
	if w.Code != 405 || reader.calls != 2 {
		t.Fatalf("fallback %d calls %d", w.Code, reader.calls)
	}
}
