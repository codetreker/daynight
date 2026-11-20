package github

import (
	"context"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"log/slog"
	"net/http"
)

// ScopedAuthentication supplies the authenticated policy snapshot to the
// request's existing protocol adapters without persisting it in the actor.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}
type scopedAuthorizationKey struct{}
type scopedAuthenticationAdapter struct{ auth ScopedAuthentication }

func (a scopedAuthenticationAdapter) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, auth model.CredentialAuthorization) {
		ctx := context.WithValue(r.Context(), scopedAuthorizationKey{}, auth)
		next(w, r.WithContext(ctx), auth.Principal)
	})
}
func authorizationFromRequest(ctx context.Context, principal model.Principal) (model.CredentialAuthorization, error) {
	auth, ok := ctx.Value(scopedAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok || auth.Principal != principal {
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	return auth, nil
}

type ScopedReaderOperations interface {
	ListAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ListRequest) (core.Page, error)
	RepositoriesAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.RepositoriesRequest) (core.RepositoriesPage, error)
	DetailAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, number int64, repositoryID *int64) (core.Detail, error)
	ReviewAssignmentAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, number int64, repositoryID *int64) (core.ReviewAssignmentResult, error)
	AuthorsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.AuthorsRequest) (core.AuthorsPage, error)
	StatisticsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.StatisticsRequest) (core.Statistics, error)
}

type scopedReaderAdapter struct{ operations ScopedReaderOperations }

func (a scopedReaderAdapter) List(ctx context.Context, p model.Principal, id string, in core.ListRequest) (core.Page, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.Page{}, err
	}
	return a.operations.ListAuthorized(ctx, auth, id, in)
}
func (a scopedReaderAdapter) Repositories(ctx context.Context, p model.Principal, id string, in core.RepositoriesRequest) (core.RepositoriesPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.RepositoriesPage{}, err
	}
	return a.operations.RepositoriesAuthorized(ctx, auth, id, in)
}
func (a scopedReaderAdapter) Detail(ctx context.Context, p model.Principal, id string, number int64, repositoryID *int64) (core.Detail, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.Detail{}, err
	}
	return a.operations.DetailAuthorized(ctx, auth, id, number, repositoryID)
}
func (a scopedReaderAdapter) ReviewAssignment(ctx context.Context, p model.Principal, id string, number int64, repositoryID *int64) (core.ReviewAssignmentResult, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.ReviewAssignmentResult{}, err
	}
	return a.operations.ReviewAssignmentAuthorized(ctx, auth, id, number, repositoryID)
}
func (a scopedReaderAdapter) Authors(ctx context.Context, p model.Principal, id string, in core.AuthorsRequest) (core.AuthorsPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AuthorsPage{}, err
	}
	return a.operations.AuthorsAuthorized(ctx, auth, id, in)
}
func (a scopedReaderAdapter) Statistics(ctx context.Context, p model.Principal, id string, in core.StatisticsRequest) (core.Statistics, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.Statistics{}, err
	}
	return a.operations.StatisticsAuthorized(ctx, auth, id, in)
}

type ScopedAppsOperations interface {
	CreateAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.CreateAppInput) (core.AppMetadata, error)
	GetAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string) (core.AppMetadata, error)
	ListAppsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.ListAppsInput) (core.AppPage, error)
}

type scopedAppsAdapter struct{ operations ScopedAppsOperations }

func (a scopedAppsAdapter) CreateApp(ctx context.Context, p model.Principal, in core.CreateAppInput) (core.AppMetadata, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AppMetadata{}, err
	}
	return a.operations.CreateAppAuthorized(ctx, auth, in)
}
func (a scopedAppsAdapter) GetApp(ctx context.Context, p model.Principal, id string) (core.AppMetadata, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AppMetadata{}, err
	}
	return a.operations.GetAppAuthorized(ctx, auth, id)
}
func (a scopedAppsAdapter) ListApps(ctx context.Context, p model.Principal, in core.ListAppsInput) (core.AppPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AppPage{}, err
	}
	return a.operations.ListAppsAuthorized(ctx, auth, in)
}

type ScopedConfigOperations interface {
	UpdateAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.UpdateAppInput) (core.AppMetadata, error)
	RemoveAppAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.RemoveAppInput) error
}

type scopedConfigAdapter struct{ operations ScopedConfigOperations }

func (a scopedConfigAdapter) UpdateApp(ctx context.Context, p model.Principal, id string, in core.UpdateAppInput) (core.AppMetadata, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AppMetadata{}, err
	}
	return a.operations.UpdateAppAuthorized(ctx, auth, id, in)
}
func (a scopedConfigAdapter) RemoveApp(ctx context.Context, p model.Principal, id string, in core.RemoveAppInput) error {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return err
	}
	return a.operations.RemoveAppAuthorized(ctx, auth, id, in)
}

type ScopedAdminOperations interface {
	ListAdminsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ListAppsInput) (core.AdminPage, error)
	ListAdminInvitationsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ListAppsInput) (core.AdminInvitationPage, error)
	CreateAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id, expected string) (core.MintedAdminInvitation, error)
	RevokeAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id, invitation, expected string) (core.AdminInvitationRevocation, error)
	RemoveAdminAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id, user string, in core.RemoveAdminInput) (core.AdminRemoval, error)
	InspectAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, token string) (core.AdminInvitationInspection, error)
	AcceptAdminInvitationAuthorized(ctx context.Context, authorization model.CredentialAuthorization, token, expected string) (core.AdminInvitationAcceptance, error)
}

type scopedAdminAdapter struct{ operations ScopedAdminOperations }

func (a scopedAdminAdapter) ListAdmins(ctx context.Context, p model.Principal, id string, in core.ListAppsInput) (core.AdminPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AdminPage{}, err
	}
	return a.operations.ListAdminsAuthorized(ctx, auth, id, in)
}
func (a scopedAdminAdapter) ListAdminInvitations(ctx context.Context, p model.Principal, id string, in core.ListAppsInput) (core.AdminInvitationPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AdminInvitationPage{}, err
	}
	return a.operations.ListAdminInvitationsAuthorized(ctx, auth, id, in)
}
func (a scopedAdminAdapter) CreateAdminInvitation(ctx context.Context, p model.Principal, id, expected string) (core.MintedAdminInvitation, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.MintedAdminInvitation{}, err
	}
	return a.operations.CreateAdminInvitationAuthorized(ctx, auth, id, expected)
}
func (a scopedAdminAdapter) RevokeAdminInvitation(ctx context.Context, p model.Principal, id, invitation, expected string) (core.AdminInvitationRevocation, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AdminInvitationRevocation{}, err
	}
	return a.operations.RevokeAdminInvitationAuthorized(ctx, auth, id, invitation, expected)
}
func (a scopedAdminAdapter) RemoveAdmin(ctx context.Context, p model.Principal, id, user string, in core.RemoveAdminInput) (core.AdminRemoval, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AdminRemoval{}, err
	}
	return a.operations.RemoveAdminAuthorized(ctx, auth, id, user, in)
}
func (a scopedAdminAdapter) InspectAdminInvitation(ctx context.Context, p model.Principal, token string) (core.AdminInvitationInspection, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AdminInvitationInspection{}, err
	}
	return a.operations.InspectAdminInvitationAuthorized(ctx, auth, token)
}
func (a scopedAdminAdapter) AcceptAdminInvitation(ctx context.Context, p model.Principal, token, expected string) (core.AdminInvitationAcceptance, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AdminInvitationAcceptance{}, err
	}
	return a.operations.AcceptAdminInvitationAuthorized(ctx, auth, token, expected)
}

type ScopedGrantsOperations interface {
	PreviewGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app, team string) (store.GitHubGrantPreview, error)
	GetGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app, grant string) (store.GitHubTeamGrant, error)
	ListGrantsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app string, limit int, cursor string) (core.GrantPage, error)
	ListTeamAppsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, team string, limit int, cursor string) (core.TeamAppPage, error)
	CreateGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app string, in core.CreateGrantInput) (store.GitHubTeamGrant, error)
	RevokeGrantAuthorized(ctx context.Context, authorization model.CredentialAuthorization, app, grant string, in core.RevokeGrantInput) error
	ImpactAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.AppImpactInput) (core.AppImpactPage, error)
	ImpactProjectsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, in core.AppImpactInput) (core.AppImpactProjectsPage, error)
}

type scopedGrantsAdapter struct{ operations ScopedGrantsOperations }

func (a scopedGrantsAdapter) PreviewGrant(ctx context.Context, p model.Principal, app, team string) (store.GitHubGrantPreview, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return store.GitHubGrantPreview{}, err
	}
	return a.operations.PreviewGrantAuthorized(ctx, auth, app, team)
}
func (a scopedGrantsAdapter) GetGrant(ctx context.Context, p model.Principal, app, grant string) (store.GitHubTeamGrant, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return store.GitHubTeamGrant{}, err
	}
	return a.operations.GetGrantAuthorized(ctx, auth, app, grant)
}
func (a scopedGrantsAdapter) ListGrants(ctx context.Context, p model.Principal, app string, limit int, cursor string) (core.GrantPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.GrantPage{}, err
	}
	return a.operations.ListGrantsAuthorized(ctx, auth, app, limit, cursor)
}
func (a scopedGrantsAdapter) ListTeamApps(ctx context.Context, p model.Principal, team string, limit int, cursor string) (core.TeamAppPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.TeamAppPage{}, err
	}
	return a.operations.ListTeamAppsAuthorized(ctx, auth, team, limit, cursor)
}
func (a scopedGrantsAdapter) CreateGrant(ctx context.Context, p model.Principal, app string, in core.CreateGrantInput) (store.GitHubTeamGrant, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return store.GitHubTeamGrant{}, err
	}
	return a.operations.CreateGrantAuthorized(ctx, auth, app, in)
}
func (a scopedGrantsAdapter) RevokeGrant(ctx context.Context, p model.Principal, app, grant string, in core.RevokeGrantInput) error {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return err
	}
	return a.operations.RevokeGrantAuthorized(ctx, auth, app, grant, in)
}
func (a scopedGrantsAdapter) Impact(ctx context.Context, p model.Principal, in core.AppImpactInput) (core.AppImpactPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AppImpactPage{}, err
	}
	return a.operations.ImpactAuthorized(ctx, auth, in)
}
func (a scopedGrantsAdapter) ImpactProjects(ctx context.Context, p model.Principal, in core.AppImpactInput) (core.AppImpactProjectsPage, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.AppImpactProjectsPage{}, err
	}
	return a.operations.ImpactProjectsAuthorized(ctx, auth, in)
}

type ScopedProjectOperations interface {
	GetAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string) (core.ProjectAppStatus, error)
	DiscoverAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error)
	ConnectAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error)
	DisconnectAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error)
	SettingsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, version int64, minutes int32) (core.ProjectAppStatus, error)
	SyncAuthorized(ctx context.Context, authorization model.CredentialAuthorization, id string, version int64, enabled bool) (core.ProjectAppStatus, error)
}

type scopedProjectAdapter struct{ operations ScopedProjectOperations }

func (a scopedProjectAdapter) Get(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	return a.operations.GetAuthorized(ctx, auth, id)
}
func (a scopedProjectAdapter) Discover(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	return a.operations.DiscoverAuthorized(ctx, auth, id, in)
}
func (a scopedProjectAdapter) Connect(ctx context.Context, p model.Principal, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	return a.operations.ConnectAuthorized(ctx, auth, id, in)
}
func (a scopedProjectAdapter) Disconnect(ctx context.Context, p model.Principal, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	return a.operations.DisconnectAuthorized(ctx, auth, id, in)
}
func (a scopedProjectAdapter) Settings(ctx context.Context, p model.Principal, id string, version int64, minutes int32) (core.ProjectAppStatus, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	return a.operations.SettingsAuthorized(ctx, auth, id, version, minutes)
}
func (a scopedProjectAdapter) Sync(ctx context.Context, p model.Principal, id string, version int64, enabled bool) (core.ProjectAppStatus, error) {
	auth, err := authorizationFromRequest(ctx, p)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	return a.operations.SyncAuthorized(ctx, auth, id, version, enabled)
}

// RegisterScopedPullRequestRoutes binds the existing HTTP parsing and response
// behavior to policy-aware operations and the same route registry.
func RegisterScopedPullRequestRoutes(routes *RouteRegistry, operations ScopedReaderOperations, auth ScopedAuthentication, logger *slog.Logger) {
	registerPullRequestRoutes(routes, scopedReaderAdapter{operations}, scopedAuthenticationAdapter{auth}, logger)
}
func RegisterScopedAppRoutes(routes *RouteRegistry, apps ScopedAppsOperations, config ScopedConfigOperations, auth ScopedAuthentication, origin string, logger *slog.Logger) {
	registerAppRoutes(routes, scopedAppsAdapter{apps}, scopedAuthenticationAdapter{auth}, origin, logger, scopedConfigAdapter{config})
}
func RegisterScopedAdminRoutes(routes *RouteRegistry, operations ScopedAdminOperations, auth ScopedAuthentication, origin string, logger *slog.Logger) {
	registerAdminRoutes(routes, scopedAdminAdapter{operations}, scopedAuthenticationAdapter{auth}, origin, logger)
}
func RegisterScopedGrantRoutes(routes *RouteRegistry, operations ScopedGrantsOperations, auth ScopedAuthentication, logger *slog.Logger) {
	registerGrantRoutes(routes, scopedGrantsAdapter{operations}, scopedAuthenticationAdapter{auth}, logger)
}
func RegisterScopedProjectAppRoutes(routes *RouteRegistry, operations ScopedProjectOperations, auth ScopedAuthentication, logger *slog.Logger) {
	registerProjectAppRoutes(routes, scopedProjectAdapter{operations}, scopedAuthenticationAdapter{auth}, logger)
}
