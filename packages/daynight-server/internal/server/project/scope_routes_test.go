package project

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

type scopedTestAuth struct{ authorization model.CredentialAuthorization }

func (a scopedTestAuth) Origin() string { return "https://example.test" }
func (a scopedTestAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, a.authorization) }
}

type scopedTestProjects struct {
	scopedProjects
	calls int
}

func (s *scopedTestProjects) ListScoped(_ context.Context, a model.CredentialAuthorization, _ coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	s.calls++
	return coreproject.ProjectPage{}, a.Require(scopepolicy.ProjectRead)
}

type scopedTestMemberships struct{ scopedMemberships }
type scopedTestDirectMembers struct{ scopedDirectMembers }

func TestScopedProjectRoutesPreserveAuthenticationAndRefusal(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"project:write"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		auth   model.CredentialAuthorization
		status int
		calls  int
		header string
	}{
		{"missing scope", model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}, http.StatusForbidden, 1, "insufficient_scope"},
		{"missing policy", model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile}, http.StatusUnauthorized, 0, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			projects := &scopedTestProjects{}
			mux := http.NewServeMux()
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			if err := RegisterScopedRoutes(mux, projects, scopedTestMemberships{}, scopedTestDirectMembers{}, scopedTestAuth{tc.auth}, logger); err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
			if response.Code != tc.status || projects.calls != tc.calls || response.Header().Get("Daynight-Scope-Status") != tc.header {
				t.Fatalf("status=%d calls=%d scope=%q body=%s", response.Code, projects.calls, response.Header().Get("Daynight-Scope-Status"), response.Body.String())
			}
		})
	}
	if _, err := scopedAuthorization(context.Background(), principal); err == nil {
		t.Fatal("missing request authorization accepted")
	}
	ctx := context.WithValue(context.Background(), scopedAuthorizationKey{}, model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy})
	principal.CredentialID = "33333333-3333-4333-8333-333333333333"
	if _, err := scopedAuthorization(ctx, principal); err == nil {
		t.Fatal("mismatched principal accepted")
	}
}
