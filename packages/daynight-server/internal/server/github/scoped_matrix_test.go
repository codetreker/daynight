package github

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type scopedHTTPMatrixSpy struct {
	t             *testing.T
	authorization model.CredentialAuthorization
	called        string
	args          []any
}

func (s *scopedHTTPMatrixSpy) record(ctx context.Context, authorization model.CredentialAuthorization, name string, args ...any) error {
	s.t.Helper()
	if ctx.Err() != nil || !reflect.DeepEqual(authorization, s.authorization) {
		s.t.Errorf("authorization/context changed for %s", name)
	}
	if s.called != "" {
		s.t.Errorf("unexpected additional operation %s", name)
	}
	s.called, s.args = name, args
	return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
}
func (s *scopedHTTPMatrixSpy) ListAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ListRequest) (core.Page, error) {
	return core.Page{}, s.record(ctx, authorization, "ListAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) RepositoriesAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.RepositoriesRequest) (core.RepositoriesPage, error) {
	return core.RepositoriesPage{}, s.record(ctx, authorization, "RepositoriesAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) DetailAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, number int64, repositoryID *int64) (core.Detail, error) {
	return core.Detail{}, s.record(ctx, authorization, "DetailAuthorized", id, number, repositoryID)
}
func (s *scopedHTTPMatrixSpy) ReviewAssignmentAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, number int64, repositoryID *int64) (core.ReviewAssignmentResult, error) {
	return core.ReviewAssignmentResult{}, s.record(ctx, authorization, "ReviewAssignmentAuthorized", id, number, repositoryID)
}
func (s *scopedHTTPMatrixSpy) AuthorsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.AuthorsRequest) (core.AuthorsPage, error) {
	return core.AuthorsPage{}, s.record(ctx, authorization, "AuthorsAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) StatisticsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.StatisticsRequest) (core.Statistics, error) {
	return core.Statistics{}, s.record(ctx, authorization, "StatisticsAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) CreateAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.CreateAppInput) (core.AppMetadata, error) {
	return core.AppMetadata{}, s.record(ctx, authorization, "CreateAppAuthorized", in)
}
func (s *scopedHTTPMatrixSpy) GetAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string) (core.AppMetadata, error) {
	return core.AppMetadata{}, s.record(ctx, authorization, "GetAppAuthorized", id)
}
func (s *scopedHTTPMatrixSpy) ListAppsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.ListAppsInput) (core.AppPage, error) {
	return core.AppPage{}, s.record(ctx, authorization, "ListAppsAuthorized", in)
}
func (s *scopedHTTPMatrixSpy) UpdateAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.UpdateAppInput) (core.AppMetadata, error) {
	return core.AppMetadata{}, s.record(ctx, authorization, "UpdateAppAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) RemoveAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.RemoveAppInput) error {
	return s.record(ctx, authorization, "RemoveAppAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) ListAdminsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ListAppsInput) (core.AdminPage, error) {
	return core.AdminPage{}, s.record(ctx, authorization, "ListAdminsAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) ListAdminInvitationsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ListAppsInput) (core.AdminInvitationPage, error) {
	return core.AdminInvitationPage{}, s.record(ctx, authorization, "ListAdminInvitationsAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) CreateAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id, expected string) (core.MintedAdminInvitation, error) {
	return core.MintedAdminInvitation{}, s.record(ctx, authorization, "CreateAdminInvitationAuthorized", id, expected)
}
func (s *scopedHTTPMatrixSpy) RevokeAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id, invitation, expected string) (core.AdminInvitationRevocation, error) {
	return core.AdminInvitationRevocation{}, s.record(ctx, authorization, "RevokeAdminInvitationAuthorized", id, invitation, expected)
}
func (s *scopedHTTPMatrixSpy) RemoveAdminAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id, user string, in core.RemoveAdminInput) (core.AdminRemoval, error) {
	return core.AdminRemoval{}, s.record(ctx, authorization, "RemoveAdminAuthorized", id, user, in)
}
func (s *scopedHTTPMatrixSpy) InspectAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, token string) (core.AdminInvitationInspection, error) {
	return core.AdminInvitationInspection{}, s.record(ctx, authorization, "InspectAdminInvitationAuthorized", token)
}
func (s *scopedHTTPMatrixSpy) AcceptAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, token, expected string) (core.AdminInvitationAcceptance, error) {
	return core.AdminInvitationAcceptance{}, s.record(ctx, authorization, "AcceptAdminInvitationAuthorized", token, expected)
}
func (s *scopedHTTPMatrixSpy) PreviewGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app, team string) (store.GitHubGrantPreview, error) {
	return store.GitHubGrantPreview{}, s.record(ctx, authorization, "PreviewGrantAuthorized", app, team)
}
func (s *scopedHTTPMatrixSpy) GetGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app, grant string) (store.GitHubTeamGrant, error) {
	return store.GitHubTeamGrant{}, s.record(ctx, authorization, "GetGrantAuthorized", app, grant)
}
func (s *scopedHTTPMatrixSpy) ListGrantsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app string, limit int, cursor string) (core.GrantPage, error) {
	return core.GrantPage{}, s.record(ctx, authorization, "ListGrantsAuthorized", app, limit, cursor)
}
func (s *scopedHTTPMatrixSpy) ListTeamAppsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, team string, limit int, cursor string) (core.TeamAppPage, error) {
	return core.TeamAppPage{}, s.record(ctx, authorization, "ListTeamAppsAuthorized", team, limit, cursor)
}
func (s *scopedHTTPMatrixSpy) CreateGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app string, in core.CreateGrantInput) (store.GitHubTeamGrant, error) {
	return store.GitHubTeamGrant{}, s.record(ctx, authorization, "CreateGrantAuthorized", app, in)
}
func (s *scopedHTTPMatrixSpy) RevokeGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app, grant string, in core.RevokeGrantInput) error {
	return s.record(ctx, authorization, "RevokeGrantAuthorized", app, grant, in)
}
func (s *scopedHTTPMatrixSpy) ImpactAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.AppImpactInput) (core.AppImpactPage, error) {
	return core.AppImpactPage{}, s.record(ctx, authorization, "ImpactAuthorized", in)
}
func (s *scopedHTTPMatrixSpy) ImpactProjectsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.AppImpactInput) (core.AppImpactProjectsPage, error) {
	return core.AppImpactProjectsPage{}, s.record(ctx, authorization, "ImpactProjectsAuthorized", in)
}
func (s *scopedHTTPMatrixSpy) GetAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string) (core.ProjectAppStatus, error) {
	return core.ProjectAppStatus{}, s.record(ctx, authorization, "GetAuthorized", id)
}
func (s *scopedHTTPMatrixSpy) DiscoverAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
	return core.InstallationCandidate{}, s.record(ctx, authorization, "DiscoverAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) ConnectAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
	return core.ProjectAppStatus{}, s.record(ctx, authorization, "ConnectAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) DisconnectAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
	return core.ProjectAppStatus{}, s.record(ctx, authorization, "DisconnectAuthorized", id, in)
}
func (s *scopedHTTPMatrixSpy) SettingsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, version int64, minutes int32) (core.ProjectAppStatus, error) {
	return core.ProjectAppStatus{}, s.record(ctx, authorization, "SettingsAuthorized", id, version, minutes)
}
func (s *scopedHTTPMatrixSpy) SyncAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, version int64, enabled bool) (core.ProjectAppStatus, error) {
	return core.ProjectAppStatus{}, s.record(ctx, authorization, "SyncAuthorized", id, version, enabled)
}

func TestScopedGitHubRoutesForwardIdentityAndArguments(t *testing.T) {
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"github:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	authorization := model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}, Profile: model.ScopedPATProfile, Policy: &policy}
	spy := &scopedHTTPMatrixSpy{t: t, authorization: authorization}
	auth := &githubScopeAuth{value: authorization}
	mux := http.NewServeMux()
	registry := NewRouteRegistry(mux, nil)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	RegisterScopedPullRequestRoutes(registry, spy, auth, logger)
	RegisterScopedAppRoutes(registry, spy, spy, auth, "https://example.test", logger)
	RegisterScopedAdminRoutes(registry, spy, auth, "https://example.test", logger)
	RegisterScopedGrantRoutes(registry, spy, auth, logger)
	RegisterScopedProjectAppRoutes(registry, spy, auth, logger)
	const app = "33333333-3333-4333-8333-333333333333"
	const grant = "44444444-4444-4444-8444-444444444444"
	const target = "55555555-5555-4555-8555-555555555555"
	appPath := "/api/v1/github/apps/" + app
	projectPath := "/api/v1/projects/" + app
	expected := authorization.Principal.UserID
	selection := core.ProjectAppSelection{AppResourceID: app, AppVersion: 2, GrantID: grant, OwnershipVersion: 3}
	selectionQuery := "?appResourceId=" + app + "&appVersion=2&grantId=" + grant + "&ownershipVersion=3"
	selectJSON := `"appResourceId":"` + app + `","appVersion":"2","grantId":"` + grant + `","ownershipVersion":"3"`
	grantRef := grant
	name := "new name"
	cases := []struct {
		method, path, body, operation string
		args                          []any
	}{
		{"GET", projectPath + "/pull-requests?limit=5", "", "ListAuthorized", []any{app, core.ListRequest{State: "active", Limit: 5}}},
		{"GET", projectPath + "/pull-request-repositories?limit=4", "", "RepositoriesAuthorized", []any{app, core.RepositoriesRequest{Limit: 4}}},
		{"GET", projectPath + "/pull-requests/42", "", "DetailAuthorized", []any{app, int64(42), (*int64)(nil)}},
		{"GET", projectPath + "/pull-requests/42/review-assignment", "", "ReviewAssignmentAuthorized", []any{app, int64(42), (*int64)(nil)}},
		{"GET", projectPath + "/pull-request-authors?limit=6&q=alice", "", "AuthorsAuthorized", []any{app, core.AuthorsRequest{Limit: 6, Query: "alice"}}},
		{"GET", strings.Replace(statisticsURL(statisticsWindow()), projectID, app, 1), "", "StatisticsAuthorized", nil},
		{"GET", "/api/v1/github/apps?limit=6", "", "ListAppsAuthorized", []any{core.ListAppsInput{Limit: 6}}},
		{"GET", appPath, "", "GetAppAuthorized", []any{app}},
		{"POST", "/api/v1/github/apps", `{"id":"` + app + `","name":"App","githubAppId":"17","privateKeyPem":"key","webhookSecret":"secret","expectedUserId":"` + expected + `"}`, "CreateAppAuthorized", []any{core.CreateAppInput{ID: app, Name: "App", GitHubAppID: 17, PrivateKeyPEM: "key", WebhookSecret: "secret", ExpectedUserID: expected}}},
		{"PATCH", appPath, `{"version":"2","name":"new name","expectedUserId":"` + expected + `"}`, "UpdateAppAuthorized", []any{app, core.UpdateAppInput{Version: 2, Name: &name, ExpectedUserID: expected}}},
		{"POST", appPath + "/remove", `{"version":"2","impactVersion":"3","expectedUserId":"` + expected + `"}`, "RemoveAppAuthorized", []any{app, core.RemoveAppInput{Version: 2, ImpactVersion: 3, ExpectedUserID: expected}}},
		{"GET", appPath + "/admins?limit=6", "", "ListAdminsAuthorized", []any{app, core.ListAppsInput{Limit: 6}}},
		{"GET", appPath + "/admin-invitations?limit=7", "", "ListAdminInvitationsAuthorized", []any{app, core.ListAppsInput{Limit: 7}}},
		{"POST", appPath + "/admin-invitations", `{"expectedUserId":"` + expected + `"}`, "CreateAdminInvitationAuthorized", []any{app, expected}},
		{"POST", appPath + "/admin-invitations/" + grant + "/revoke", `{"expectedUserId":"` + expected + `"}`, "RevokeAdminInvitationAuthorized", []any{app, grant, expected}},
		{"POST", appPath + "/admins/" + target + "/remove", `{"membershipVersion":"2","expectedUserId":"` + expected + `"}`, "RemoveAdminAuthorized", []any{app, target, core.RemoveAdminInput{MembershipVersion: 2, ExpectedUserID: expected}}},
		{"POST", "/api/v1/github-app-admin-invitations/inspect", `{"token":"token"}`, "InspectAdminInvitationAuthorized", []any{"token"}},
		{"POST", "/api/v1/github-app-admin-invitations/accept", `{"token":"token","expectedUserId":"` + expected + `"}`, "AcceptAdminInvitationAuthorized", []any{"token", expected}},
		{"POST", appPath + "/team-grant-preview", `{"teamId":"` + target + `"}`, "PreviewGrantAuthorized", []any{app, target}},
		{"GET", appPath + "/team-grants/" + grant, "", "GetGrantAuthorized", []any{app, grant}},
		{"GET", appPath + "/team-grants?limit=8&cursor=c", "", "ListGrantsAuthorized", []any{app, 8, "c"}},
		{"GET", "/api/v1/teams/" + target + "/github/apps?limit=9&cursor=c", "", "ListTeamAppsAuthorized", []any{target, 9, "c"}},
		{"POST", appPath + "/team-grants", `{"id":"` + grant + `","teamId":"` + target + `","version":"2","teamVersion":"3","expectedUserId":"` + expected + `"}`, "CreateGrantAuthorized", []any{app, core.CreateGrantInput{ID: grant, TeamID: target, Version: 2, TeamVersion: 3, ExpectedUserID: expected}}},
		{"POST", appPath + "/team-grants/" + grant + "/revoke", `{"version":"2","impactVersion":"3","expectedUserId":"` + expected + `"}`, "RevokeGrantAuthorized", []any{app, grant, core.RevokeGrantInput{Version: 2, ImpactVersion: 3, ExpectedUserID: expected}}},
		{"GET", appPath + "/removal-preview?limit=10", "", "ImpactAuthorized", []any{core.AppImpactInput{AppID: app, Limit: 10}}},
		{"GET", appPath + "/team-grants/" + grant + "/revocation-preview/projects?limit=11", "", "ImpactProjectsAuthorized", []any{core.AppImpactInput{AppID: app, GrantID: &grantRef, Limit: 11}}},
		{"GET", projectPath + "/github", "", "GetAuthorized", []any{app}},
		{"GET", projectPath + "/github/installation" + selectionQuery, "", "DiscoverAuthorized", []any{app, selection}},
		{"POST", projectPath + "/github/connect", `{` + selectJSON + `,"version":"4","installationId":"5"}`, "ConnectAuthorized", []any{app, core.ProjectAppConnect{ProjectAppSelection: selection, Version: 4, InstallationID: 5}}},
		{"POST", projectPath + "/github/disconnect", `{"version":"4","ownershipVersion":"3"}`, "DisconnectAuthorized", []any{app, core.ProjectAppDisconnect{Version: 4, OwnershipVersion: 3}}},
		{"PATCH", projectPath + "/github/settings", `{"version":"4","pollIntervalMinutes":5}`, "SettingsAuthorized", []any{app, int64(4), int32(5)}},
		{"PATCH", projectPath + "/github/sync", `{"version":"4","syncEnabled":true}`, "SyncAuthorized", []any{app, int64(4), true}},
	}
	for _, tc := range cases {
		t.Run(tc.operation, func(t *testing.T) {
			spy.called, spy.args = "", nil
			request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			if tc.body != "" {
				request.Header.Set("Content-Type", "application/json")
			}
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || !strings.Contains(response.Body.String(), `"code":"forbidden"`) {
				t.Fatalf("response %d %v %s", response.Code, response.Header(), response.Body.String())
			}
			if spy.called != tc.operation {
				t.Fatalf("operation %q want %q", spy.called, tc.operation)
			}
			if tc.args != nil && !reflect.DeepEqual(spy.args, tc.args) {
				t.Fatalf("arguments %#v want %#v", spy.args, tc.args)
			}
			if tc.args == nil {
				if len(spy.args) != 2 || spy.args[0] != app {
					t.Fatalf("statistics arguments %#v", spy.args)
				}
				input, ok := spy.args[1].(core.StatisticsRequest)
				if !ok || input.EndDate != "2026-03-08" || len(input.Window) != 4 || input.Window[0].DateIndex != 0 || input.Window[1].DateIndex != 1 || input.Window[3].DateIndex != -1 {
					t.Fatalf("statistics input %#v", spy.args[1])
				}
			}
		})
	}
}

func TestScopedGitHubAdaptersRejectMissingOrMismatchedAuthorization(t *testing.T) {
	spy := &scopedHTTPMatrixSpy{t: t}
	adapters := []any{scopedReaderAdapter{spy}, scopedAppsAdapter{spy}, scopedConfigAdapter{spy}, scopedAdminAdapter{spy}, scopedGrantsAdapter{spy}, scopedProjectAdapter{spy}}
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
	for _, adapter := range adapters {
		value := reflect.ValueOf(adapter)
		for i := 0; i < value.NumMethod(); i++ {
			method := value.Method(i)
			args := make([]reflect.Value, method.Type().NumIn())
			args[0] = reflect.ValueOf(context.Background())
			args[1] = reflect.ValueOf(principal)
			for j := 2; j < len(args); j++ {
				args[j] = reflect.Zero(method.Type().In(j))
			}
			result := method.Call(args)
			if result[len(result)-1].IsNil() {
				t.Errorf("%T.%s accepted missing authorization", adapter, value.Type().Method(i).Name)
			} else if fault, ok := result[len(result)-1].Interface().(*model.Fault); !ok || fault.Code != "unauthenticated" {
				t.Errorf("%T.%s returned wrong refusal: %v", adapter, value.Type().Method(i).Name, result[len(result)-1].Interface())
			}
		}
	}
	ctx := context.WithValue(context.Background(), scopedAuthorizationKey{}, model.CredentialAuthorization{Principal: model.Principal{UserID: "different"}})
	if _, err := authorizationFromRequest(ctx, principal); err == nil {
		t.Fatal("mismatched principal accepted")
	}
	if spy.called != "" {
		t.Fatalf("denial called %s", spy.called)
	}
}

func TestExportedGitHubRouteRegistrarsRecordActualPatterns(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	for _, tc := range []struct {
		name, pattern string
		register      func(*RouteRegistry)
	}{
		{"reader", "GET /api/v1/projects/{projectId}/pull-requests", func(r *RouteRegistry) { RegisterPullRequestRoutesWithRegistry(r, nil, authStub{}, logger) }},
		{"apps", "GET /api/v1/github/apps", func(r *RouteRegistry) {
			RegisterAppRoutesWithRegistry(r, nil, authStub{}, "https://example.test", logger, scopeRouteConfig{})
		}},
		{"admins", "GET /api/v1/github/apps/{id}/admins", func(r *RouteRegistry) {
			RegisterAdminRoutesWithRegistry(r, nil, authStub{}, "https://example.test", logger)
		}},
		{"grants", "GET /api/v1/github/apps/{id}/team-grants", func(r *RouteRegistry) { RegisterGrantRoutesWithRegistry(r, nil, authStub{}, logger) }},
		{"project", "GET /api/v1/projects/{projectId}/github", func(r *RouteRegistry) { RegisterProjectAppRoutesWithRegistry(r, nil, authStub{}, logger) }},
		{"webhook", "POST /api/v1/github/apps/{localAppId}/webhook", func(r *RouteRegistry) { RegisterAppWebhookRouteWithRegistry(r, nil, logger) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			found := false
			tc.register(NewRouteRegistry(mux, func(route ScopeRoute) {
				if route.Pattern == tc.pattern {
					found = true
				}
			}))
			if !found {
				t.Fatalf("missing registered classification %s", tc.pattern)
			}
		})
	}
}
