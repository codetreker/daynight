package mcp

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

// ScopedProjectOperations must enforce resource visibility and the operation's
// policy together before exposing data or changing state.
type ScopedProjectOperations interface {
	RegisterRepository(context.Context, model.CredentialAuthorization, coreproject.CreateProject, bool) (model.Project, bool, error)
	ResolveRepository(context.Context, model.CredentialAuthorization, string) (model.Project, error)
	Get(context.Context, model.CredentialAuthorization, string) (model.Project, error)
	ListScoped(context.Context, model.CredentialAuthorization, coreproject.ProjectListRequest) (coreproject.ProjectPage, error)
	TransferPreview(context.Context, model.CredentialAuthorization, string, string) (coreproject.TransferPreview, error)
	TransferPreviewWithName(context.Context, model.CredentialAuthorization, string, string) (coreproject.TransferPreview, string, error)
	Transfer(context.Context, model.CredentialAuthorization, string, coreproject.TransferInput) (coreproject.TransferReceipt, error)
	RepositoryPreview(context.Context, model.CredentialAuthorization, string, string, string) (coreproject.RepositoryPreview, error)
	SetRepository(context.Context, model.CredentialAuthorization, string, coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error)
}

type scopedAuthorizationKey struct{}

func scopedAuthorization(ctx context.Context, principal model.Principal) (model.CredentialAuthorization, error) {
	a, ok := ctx.Value(scopedAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok || a.Principal != principal || a.Validate() != nil {
		return model.CredentialAuthorization{}, errors.New("scoped authorization unavailable")
	}
	return a, nil
}

type scopedProjectAdapter struct{ projects ScopedProjectOperations }

func (s scopedProjectAdapter) RegisterRepository(ctx context.Context, p model.Principal, input coreproject.CreateProject, confirm bool) (model.Project, bool, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Project{}, false, err
	}
	return s.projects.RegisterRepository(ctx, a, input, confirm)
}
func (s scopedProjectAdapter) ResolveRepository(ctx context.Context, p model.Principal, address string) (model.Project, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Project{}, err
	}
	return s.projects.ResolveRepository(ctx, a, address)
}
func (s scopedProjectAdapter) Get(ctx context.Context, p model.Principal, id string) (model.Project, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return model.Project{}, err
	}
	return s.projects.Get(ctx, a, id)
}
func (s scopedProjectAdapter) ListScoped(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.ProjectPage{}, err
	}
	return s.projects.ListScoped(ctx, a, input)
}
func (s scopedProjectAdapter) TransferPreview(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.TransferPreview{}, err
	}
	return s.projects.TransferPreview(ctx, a, id, target)
}
func (s scopedProjectAdapter) TransferPreviewWithName(ctx context.Context, p model.Principal, id, target string) (coreproject.TransferPreview, string, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.TransferPreview{}, "", err
	}
	return s.projects.TransferPreviewWithName(ctx, a, id, target)
}
func (s scopedProjectAdapter) Transfer(ctx context.Context, p model.Principal, id string, input coreproject.TransferInput) (coreproject.TransferReceipt, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.TransferReceipt{}, err
	}
	return s.projects.Transfer(ctx, a, id, input)
}
func (s scopedProjectAdapter) RepositoryPreview(ctx context.Context, p model.Principal, id, address, expected string) (coreproject.RepositoryPreview, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.RepositoryPreview{}, err
	}
	return s.projects.RepositoryPreview(ctx, a, id, address, expected)
}
func (s scopedProjectAdapter) SetRepository(ctx context.Context, p model.Principal, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.RepositoryReceipt{}, err
	}
	return s.projects.SetRepository(ctx, a, id, input)
}

// RegisterScopedProjectTools registers the unchanged public schemas with the
// scoped service. It must be used only with scoped authentication enabled.
func RegisterScopedProjectTools(e *Entry, projects ScopedProjectOperations, identity personalTeamResolver, origin string) error {
	if e == nil || e.scopedAuth == nil || projects == nil || identity == nil {
		return errors.New("scoped Project tool dependencies are required")
	}
	if err := RegisterProjectTools(e, scopedProjectAdapter{projects}, identity, origin); err != nil {
		return err
	}
	for _, name := range []string{"project_create", "project_transfer_preview", "project_transfer", "project_preview_repository", "project_set_repository", "project_list", "project_resolve", "project_show"} {
		e.scopedTools[name] = true
	}
	return nil
}

// RegisterScopedTeamTools exposes the Team projects listing while the Team
// domain's other scoped operations are not yet registered.
func RegisterScopedTeamTools(e *Entry, teams teamOperations, projects ScopedProjectOperations, identity personalTeamResolver) error {
	if e == nil || e.scopedAuth == nil || teams == nil || projects == nil || identity == nil {
		return errors.New("scoped Team tool dependencies are required")
	}
	if err := RegisterTeamTools(e, teams, scopedProjectAdapter{projects}, identity); err != nil {
		return err
	}
	e.scopedTools["team_projects"] = true
	return nil
}

// ScopedInvitationProjects classifies the two received Project invitation operations.
type ScopedInvitationProjects interface {
	InspectInvitation(context.Context, model.CredentialAuthorization, string) (coreproject.InvitationInspection, error)
	AcceptInvitation(context.Context, model.CredentialAuthorization, string, string) (coreproject.InvitationAcceptance, error)
}
type scopedInvitationProjects struct{ projects ScopedInvitationProjects }

func (s scopedInvitationProjects) InspectInvitation(ctx context.Context, p model.Principal, secret string) (coreproject.InvitationInspection, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.InvitationInspection{}, err
	}
	return s.projects.InspectInvitation(ctx, a, secret)
}
func (s scopedInvitationProjects) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (coreproject.InvitationAcceptance, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return coreproject.InvitationAcceptance{}, err
	}
	return s.projects.AcceptInvitation(ctx, a, secret, expected)
}

// RegisterScopedInvitationTools enables only the Project branch until Team
// invitation admission is registered by the Team domain.
func RegisterScopedInvitationTools(e *Entry, identity personalTeamResolver, teams invitationTeams, projects ScopedInvitationProjects, origin string) error {
	if e == nil || e.scopedAuth == nil || identity == nil || teams == nil || projects == nil {
		return errors.New("scoped invitation tool dependencies are required")
	}
	if err := RegisterInvitationTools(e, identity, teams, scopedInvitationProjects{projects}, origin); err != nil {
		return err
	}
	e.scopedTools["invitation_inspect"] = true
	e.scopedTools["invitation_accept"] = true
	return nil
}
