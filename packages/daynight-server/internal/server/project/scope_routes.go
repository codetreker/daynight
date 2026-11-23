package project

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

// ScopedAuthentication supplies the authorization established by the same
// authentication read as the principal. Its implementation owns authentication
// failures and the existing origin policy.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
	Origin() string
}

type scopedAuthorizationKey struct{}
type scopedRouteAuthentication struct {
	ScopedAuthentication
	logger *slog.Logger
}

func (a scopedRouteAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.RequireScoped(func(w http.ResponseWriter, r *http.Request, auth model.CredentialAuthorization) {
		if err := auth.Validate(); err != nil {
			httpx.WriteError(w, r, a.logger, "project", "authentication", model.Unauthenticated(err))
			return
		}
		ctx := context.WithValue(r.Context(), scopedAuthorizationKey{}, auth)
		next(w, r.WithContext(ctx), auth.Principal)
	})
}

func scopedAuthorization(ctx context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	a, ok := ctx.Value(scopedAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok || a.Principal != p {
		return model.CredentialAuthorization{}, model.Unauthenticated(errors.New("missing or mismatched credential authorization"))
	}
	if err := a.Validate(); err != nil {
		return model.CredentialAuthorization{}, model.Unauthenticated(err)
	}
	return a, nil
}

// RegisterScopedRoutes composes the existing HTTP handlers with explicit scoped
// authorization. The caller must supply transaction-bound revalidation to the
// scoped services; this entry is separate from the legacy production assembly.
func RegisterScopedRoutes(mux httpx.RouteRegistrar, projects scopedProjects, memberships scopedMemberships, members scopedDirectMembers, auth ScopedAuthentication, logger *slog.Logger) error {
	if mux == nil || projects == nil || memberships == nil || members == nil || auth == nil || logger == nil {
		return errors.New("scoped project routes require all dependencies")
	}
	routeAuth := scopedRouteAuthentication{auth, logger}
	RegisterRoutes(mux, ScopedProjectsAdapter{projects}, routeAuth, logger)
	NewMembershipRoutes(ScopedMembershipsAdapter{memberships}, routeAuth, logger).RegisterRoutes(mux)
	RegisterDirectMemberRoute(mux, ScopedDirectMembersAdapter{members}, routeAuth, logger)
	return nil
}

type scopedProjects interface {
	CreateWithAccess(ctx context.Context, a model.CredentialAuthorization, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error)
	GetWithAccess(ctx context.Context, a model.CredentialAuthorization, id string) (model.Project, model.ProjectAccess, error)
	ListScoped(ctx context.Context, a model.CredentialAuthorization, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
	Access(ctx context.Context, a model.CredentialAuthorization, id string) (model.ProjectAccess, error)
	UpdateSettings(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.UpdateProjectSettings) (model.Project, error)
	TransferPreview(ctx context.Context, a model.CredentialAuthorization, id, target string) (coreproject.TransferPreview, error)
	Transfer(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error)
	DeletionPreview(ctx context.Context, a model.CredentialAuthorization, id string, page model.PageRequest) (projectservice.DeletionPreview, error)
	DeleteWithInput(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.DeletionInput) (projectservice.DeletionReceipt, error)
	RepositoryPreview(ctx context.Context, a model.CredentialAuthorization, id, address, expected string) (coreproject.RepositoryPreview, error)
	SetRepository(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error)
}

type ScopedProjectsAdapter struct{ service scopedProjects }

func (s ScopedProjectsAdapter) CreateWithAccess(ctx context.Context, p model.Principal, input coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	return s.service.CreateWithAccess(ctx, auth, input)
}
func (s ScopedProjectsAdapter) GetWithAccess(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	return s.service.GetWithAccess(ctx, auth, id)
}
func (s ScopedProjectsAdapter) ListScoped(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.ProjectPage{}, err
	}
	return s.service.ListScoped(ctx, auth, input)
}
func (s ScopedProjectsAdapter) Access(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.ProjectAccess{}, err
	}
	return s.service.Access(ctx, auth, id)
}
func (s ScopedProjectsAdapter) UpdateSettings(ctx context.Context, p model.Principal, id string, input coreproject.UpdateProjectSettings) (model.Project, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Project{}, err
	}
	return s.service.UpdateSettings(ctx, auth, id, input)
}
func (s ScopedProjectsAdapter) TransferPreview(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.TransferPreview{}, err
	}
	return s.service.TransferPreview(ctx, auth, id, target)
}
func (s ScopedProjectsAdapter) Transfer(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.TransferReceipt{}, err
	}
	return s.service.Transfer(ctx, auth, id, input)
}
func (s ScopedProjectsAdapter) DeletionPreview(ctx context.Context, p model.Principal, id string, page model.PageRequest) (projectservice.DeletionPreview, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return projectservice.DeletionPreview{}, err
	}
	return s.service.DeletionPreview(ctx, auth, id, page)
}
func (s ScopedProjectsAdapter) DeleteWithInput(ctx context.Context, p model.Principal, id string, input coreproject.DeletionInput) (projectservice.DeletionReceipt, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return projectservice.DeletionReceipt{}, err
	}
	return s.service.DeleteWithInput(ctx, auth, id, input)
}
func (s ScopedProjectsAdapter) RepositoryPreview(ctx context.Context, p model.Principal, id, address, expected string) (coreproject.RepositoryPreview, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.RepositoryPreview{}, err
	}
	return s.service.RepositoryPreview(ctx, auth, id, address, expected)
}
func (s ScopedProjectsAdapter) SetRepository(ctx context.Context, p model.Principal, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.RepositoryReceipt{}, err
	}
	return s.service.SetRepository(ctx, auth, id, input)
}

type scopedMemberships interface {
	SearchMemberCandidates(ctx context.Context, a model.CredentialAuthorization, id string, input coreproject.CandidateSearchInput) (coreproject.CandidatePage, error)
	ListWithAccess(ctx context.Context, a model.CredentialAuthorization, id string) (coreproject.ProjectParticipants, error)
	SetRole(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error)
	Remove(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.RemoveProjectMember) error
	SetGrant(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error)
	RemoveGrant(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error)
	CreateInvitation(ctx context.Context, a model.CredentialAuthorization, id, expected string) (coreproject.MintedInvitation, error)
	ListInvitations(ctx context.Context, a model.CredentialAuthorization, id string) ([]model.ProjectInvitation, error)
	RevokeInvitation(ctx context.Context, a model.CredentialAuthorization, id, invitation, expected string) error
	InspectInvitation(ctx context.Context, a model.CredentialAuthorization, secret string) (coreproject.InvitationInspection, error)
	AcceptInvitation(ctx context.Context, a model.CredentialAuthorization, secret, expected string) (coreproject.InvitationAcceptance, error)
}

type ScopedMembershipsAdapter struct{ service scopedMemberships }

func (s ScopedMembershipsAdapter) SearchMemberCandidates(ctx context.Context, p model.Principal, id string, input coreproject.CandidateSearchInput) (coreproject.CandidatePage, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.CandidatePage{}, err
	}
	return s.service.SearchMemberCandidates(ctx, auth, id, input)
}
func (s ScopedMembershipsAdapter) ListWithAccess(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.ProjectParticipants{}, err
	}
	return s.service.ListWithAccess(ctx, auth, id)
}
func (s ScopedMembershipsAdapter) SetRole(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.ProjectGrant{}, err
	}
	return s.service.SetRole(ctx, auth, projectID, userID, input)
}
func (s ScopedMembershipsAdapter) Remove(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) error {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return err
	}
	return s.service.Remove(ctx, auth, projectID, userID, input)
}
func (s ScopedMembershipsAdapter) SetGrant(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.SetGrantResult{}, err
	}
	return s.service.SetGrant(ctx, auth, projectID, userID, input)
}
func (s ScopedMembershipsAdapter) RemoveGrant(ctx context.Context, p model.Principal, projectID, userID string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.RemoveGrantResult{}, err
	}
	return s.service.RemoveGrant(ctx, auth, projectID, userID, input)
}
func (s ScopedMembershipsAdapter) CreateInvitation(ctx context.Context, p model.Principal, id, expected string) (coreproject.MintedInvitation, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.MintedInvitation{}, err
	}
	return s.service.CreateInvitation(ctx, auth, id, expected)
}
func (s ScopedMembershipsAdapter) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.ListInvitations(ctx, auth, id)
}
func (s ScopedMembershipsAdapter) RevokeInvitation(ctx context.Context, p model.Principal, id, invitation, expected string) error {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return err
	}
	return s.service.RevokeInvitation(ctx, auth, id, invitation, expected)
}
func (s ScopedMembershipsAdapter) InspectInvitation(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.InvitationInspection{}, err
	}
	return s.service.InspectInvitation(ctx, auth, secret)
}
func (s ScopedMembershipsAdapter) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.InvitationAcceptance{}, err
	}
	return s.service.AcceptInvitation(ctx, auth, secret, expected)
}

type scopedDirectMembers interface {
	AddExistingMember(ctx context.Context, a model.CredentialAuthorization, projectID, target, expected string) (coreproject.ExistingMemberResult, error)
}

var _ scopedProjects = (*projectservice.ScopedProjects)(nil)
var _ scopedMemberships = (*projectservice.ScopedMemberships)(nil)
var _ scopedDirectMembers = (*projectservice.ScopedDirectMembers)(nil)

type ScopedDirectMembersAdapter struct{ service scopedDirectMembers }

func (s ScopedDirectMembersAdapter) AddExistingMember(ctx context.Context, p model.Principal, projectID, target, expected string) (coreproject.ExistingMemberResult, error) {
	auth, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.ExistingMemberResult{}, err
	}
	return s.service.AddExistingMember(ctx, auth, projectID, target, expected)
}
