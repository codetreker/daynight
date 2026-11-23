package github

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

type scopeRouteConfig struct{ AppConfigOperations }

func TestActualGitHubRegistrationHasScopeClassification(t *testing.T) {
	mux := http.NewServeMux()
	got := map[string]ScopeRoute{}
	registry := NewRouteRegistry(mux, func(route ScopeRoute) {
		if _, exists := got[route.Pattern]; exists {
			t.Fatalf("duplicate classification %s", route.Pattern)
		}
		got[route.Pattern] = route
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth := authStub{}
	registerPullRequestRoutes(registry, nil, auth, logger)
	registerAppRoutes(registry, nil, auth, "https://example.com", logger, scopeRouteConfig{})
	registerAdminRoutes(registry, nil, auth, "https://example.com", logger)
	registerGrantRoutes(registry, nil, auth, logger)
	registerProjectAppRoutes(registry, nil, auth, logger)
	registerAppWebhookRoute(registry, nil, logger)
	projects := []string{
		"/api/v1/projects/{projectId}/pull-requests", "/api/v1/projects/{projectId}/pull-request-repositories",
		"/api/v1/projects/{projectId}/pull-requests/{number}", "/api/v1/projects/{projectId}/pull-requests/{number}/review-assignment",
		"/api/v1/projects/{projectId}/pull-request-authors", "/api/v1/projects/{projectId}/pull-request-statistics",
	}
	for _, path := range projects {
		for _, method := range []string{"GET", "HEAD"} {
			route, ok := got[method+" "+path]
			if !ok || len(route.Operations) != 1 || route.Operations[0] != scopepolicy.ProjectRead {
				t.Errorf("%s %s: %+v", method, path, route)
			}
		}
		if !got[path].Fallback {
			t.Errorf("missing fallback for %s", path)
		}
	}
	for _, pattern := range []string{"POST /api/v1/github-app-admin-invitations/inspect", "POST /api/v1/github/apps/{id}/team-grant-preview", "GET /api/v1/projects/{projectId}/github/installation"} {
		route := got[pattern]
		if len(route.Operations) != 1 || route.Operations[0] != scopepolicy.GithubRead {
			t.Errorf("%s: %+v", pattern, route)
		}
	}
	for _, pattern := range []string{"POST /api/v1/github/apps/{id}/admin-invitations", "POST /api/v1/github/apps/{id}/admin-invitations/{inviteId}/revoke", "POST /api/v1/github-app-admin-invitations/accept", "PATCH /api/v1/github/apps/{id}", "POST /api/v1/projects/{projectId}/github/connect", "POST /api/v1/github/apps/{id}/team-grants"} {
		route := got[pattern]
		if len(route.Operations) != 2 || route.Operations[0] != scopepolicy.GithubRead || route.Operations[1] != scopepolicy.GithubManage {
			t.Errorf("%s: %+v", pattern, route)
		}
	}
	if !got["POST /api/v1/github/apps/{localAppId}/webhook"].IndependentProfile {
		t.Fatal("webhook signature profile missing")
	}
	for pattern, entry := range got {
		if entry.Fallback || entry.IndependentProfile {
			continue
		}
		if len(entry.Operations) == 0 {
			t.Errorf("unclassified %s", pattern)
		}
		if strings.HasPrefix(pattern, "GET ") {
			head := got["HEAD "+strings.TrimPrefix(pattern, "GET ")]
			if len(head.Operations) != len(entry.Operations) {
				t.Errorf("automatic HEAD missing for %s", pattern)
			}
		}
	}
}
