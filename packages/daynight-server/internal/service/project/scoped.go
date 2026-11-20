package project

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ScopedProjects preserves resource visibility before business scope admission.
type ScopedProjects struct{ app *AppProjects }

func NewScopedProjects(app *AppProjects) *ScopedProjects { return &ScopedProjects{app: app} }

// visible checks existing resource access without requiring a project:read
// scope. It prevents a scope refusal from revealing an inaccessible Project.
func (s *ScopedProjects) visible(ctx context.Context, a model.CredentialAuthorization, id string, admin bool, ops ...scopepolicy.Operation) error {
	if err := a.Validate(); err != nil {
		return err
	}
	access, err := s.app.Access(ctx, a.Principal, id)
	if err != nil {
		return err
	}
	if admin {
		check := ownerAdmin
		if len(ops) > 0 && (ops[0] == scopepolicy.ProjectRepository || ops[0] == scopepolicy.ProjectWrite) {
			check = core.RequireProjectAdmin
		}
		if err := check(access); err != nil {
			return err
		}
	}
	return scopeadmission.Require(a, ops...)
}
func (s *ScopedProjects) Create(ctx context.Context, a model.CredentialAuthorization, input core.CreateProject) (model.Project, error) {
	project, _, err := s.CreateWithAccess(ctx, a, input)
	return project, err
}
func (s *ScopedProjects) CreateWithAccess(ctx context.Context, a model.CredentialAuthorization, input core.CreateProject) (model.Project, model.ProjectAccess, error) {
	if err := scopeadmission.Require(a, scopepolicy.ProjectWrite, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	return s.app.CreateWithAccess(ctx, a.Principal, input)
}
func (s *ScopedProjects) RegisterRepository(ctx context.Context, a model.CredentialAuthorization, input core.CreateProject, confirm bool) (model.Project, bool, error) {
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, false, err
	}
	return s.app.registerRepository(ctx, a.Principal, input, confirm, func() error { return scopeadmission.Require(a, scopepolicy.ProjectWrite) })
}
func (s *ScopedProjects) ResolveRepository(ctx context.Context, a model.CredentialAuthorization, address string) (model.Project, error) {
	if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, err
	}
	return s.app.ResolveRepository(ctx, a.Principal, address)
}
func (s *ScopedProjects) Get(ctx context.Context, a model.CredentialAuthorization, id string) (model.Project, error) {
	value, _, err := s.GetWithAccess(ctx, a, id)
	return value, err
}
func (s *ScopedProjects) GetWithAccess(ctx context.Context, a model.CredentialAuthorization, id string) (model.Project, model.ProjectAccess, error) {
	if err := s.visible(ctx, a, id, false, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, model.ProjectAccess{}, err
	}
	return s.app.GetWithAccess(ctx, a.Principal, id)
}
func (s *ScopedProjects) List(ctx context.Context, a model.CredentialAuthorization, request model.PageRequest) (core.ProjectPage, error) {
	return s.ListScoped(ctx, a, core.ProjectListRequest{Page: request})
}
func (s *ScopedProjects) ListScoped(ctx context.Context, a model.CredentialAuthorization, request core.ProjectListRequest) (core.ProjectPage, error) {
	if err := a.Validate(); err != nil {
		return core.ProjectPage{}, err
	}
	if err := core.ValidateList(a.Principal, request); err != nil {
		return core.ProjectPage{}, err
	}
	if request.TeamID != nil {
		teamID, err := model.CanonicalID(*request.TeamID)
		if err != nil {
			return core.ProjectPage{}, err
		}
		err = s.app.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
			if err := scope.TeamDAO().TeamAccess(ctx, a.Principal.UserID, teamID); err != nil {
				if errors.Is(err, model.ErrNotFound) {
					return &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: err}
				}
				return err
			}
			return scopeadmission.Require(a, scopepolicy.ProjectRead, scopepolicy.TeamRead)
		})
		if err != nil {
			return core.ProjectPage{}, err
		}
	} else if err := scopeadmission.Require(a, scopepolicy.ProjectRead); err != nil {
		return core.ProjectPage{}, err
	}
	return s.app.ListScoped(ctx, a.Principal, request)
}
func (s *ScopedProjects) Access(ctx context.Context, a model.CredentialAuthorization, id string) (model.ProjectAccess, error) {
	if err := s.visible(ctx, a, id, false, scopepolicy.ProjectRead); err != nil {
		return model.ProjectAccess{}, err
	}
	return s.app.Access(ctx, a.Principal, id)
}
func (s *ScopedProjects) UpdateSettings(ctx context.Context, a model.CredentialAuthorization, id string, input core.UpdateProjectSettings) (model.Project, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectWrite, scopepolicy.ProjectRead); err != nil {
		return model.Project{}, err
	}
	return s.app.UpdateSettings(ctx, a.Principal, id, input)
}
func (s *ScopedProjects) TransferPreview(ctx context.Context, a model.CredentialAuthorization, id, target string) (core.TransferPreview, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectTransfer); err != nil {
		return core.TransferPreview{}, err
	}
	return s.app.TransferPreview(ctx, a.Principal, id, target)
}

// TransferPreviewWithName obtains the name and transfer preview under the same
// snapshot, using only the transfer capability for the preview projection.
func (s *ScopedProjects) TransferPreviewWithName(ctx context.Context, a model.CredentialAuthorization, id, target string) (core.TransferPreview, string, error) {
	if err := a.Validate(); err != nil {
		return core.TransferPreview{}, "", err
	}
	id, target, err := core.ValidateTransferPreview(a.Principal, id, target)
	if err != nil {
		return core.TransferPreview{}, "", err
	}
	var out core.TransferPreview
	var name string
	err = read(ctx, s.app.store, func(dao store.ProjectReader) error {
		access, err := core.RequireProjectRead(ctx, dao, a.Principal, id)
		if err != nil {
			return err
		}
		if err := ownerAdmin(access); err != nil {
			return err
		}
		if err := scopeadmission.Require(a, scopepolicy.ProjectTransfer); err != nil {
			return err
		}
		out, err = core.TransferPreviewFor(ctx, dao, a.Principal, id, target)
		if err != nil {
			return err
		}
		project, err := dao.Project(ctx, id)
		if err != nil {
			return core.LookupError(err)
		}
		name = project.Name
		return nil
	})
	if err != nil {
		return core.TransferPreview{}, "", err
	}
	return out, name, nil
}
func (s *ScopedProjects) Transfer(ctx context.Context, a model.CredentialAuthorization, id string, input core.TransferInput) (core.TransferReceipt, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectTransfer, scopepolicy.ProjectRead); err != nil {
		return core.TransferReceipt{}, err
	}
	return s.app.Transfer(ctx, a.Principal, id, input)
}
func (s *ScopedProjects) DeletionPreview(ctx context.Context, a model.CredentialAuthorization, id string, page model.PageRequest) (DeletionPreview, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectDelete, scopepolicy.TaskRead, scopepolicy.AttachmentRead, scopepolicy.WorkerRead); err != nil {
		return DeletionPreview{}, err
	}
	return s.app.DeletionPreview(ctx, a.Principal, id, page)
}
func (s *ScopedProjects) Delete(ctx context.Context, a model.CredentialAuthorization, id string) (DeletionReceipt, error) {
	return s.DeleteWithInput(ctx, a, id, core.DeletionInput{})
}
func (s *ScopedProjects) DeleteWithInput(ctx context.Context, a model.CredentialAuthorization, id string, input core.DeletionInput) (DeletionReceipt, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectDelete); err != nil {
		return DeletionReceipt{}, err
	}
	return s.app.DeleteWithInput(ctx, a.Principal, id, input)
}
func (s *ScopedProjects) RepositoryPreview(ctx context.Context, a model.CredentialAuthorization, id, address, expected string) (core.RepositoryPreview, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectRepository); err != nil {
		return core.RepositoryPreview{}, err
	}
	return s.app.RepositoryPreview(ctx, a.Principal, id, address, expected)
}
func (s *ScopedProjects) SetRepository(ctx context.Context, a model.CredentialAuthorization, id string, input core.RepositoryChange) (core.RepositoryReceipt, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectRepository); err != nil {
		return core.RepositoryReceipt{}, err
	}
	return s.app.SetRepository(ctx, a.Principal, id, input)
}

// SnapshotAuthorization reads the original credential's current authority using
// the supplied snapshot, including its original profile and resource binding.
type SnapshotAuthorization func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error)

// DirectMemberAuthorization must lock and read current authority in the supplied
// transaction, preserving the credential's native validity and lock ordering.
type DirectMemberAuthorization func(context.Context, store.ProjectDirectMemberScope, model.Principal) (model.CredentialAuthorization, error)

func currentAuthorization(expected model.CredentialAuthorization, current model.CredentialAuthorization, ops ...scopepolicy.Operation) error {
	if current.Principal != expected.Principal || current.Profile != expected.Profile {
		return model.Unauthenticated(errors.New("credential authorization identity changed"))
	}
	return scopeadmission.Require(current, ops...)
}

type ScopedMemberships struct {
	memberships *Memberships
	current     SnapshotAuthorization
}

func NewScopedMemberships(memberships *Memberships, current SnapshotAuthorization) *ScopedMemberships {
	return &ScopedMemberships{memberships: memberships, current: current}
}
func (s *ScopedMemberships) visible(ctx context.Context, a model.CredentialAuthorization, id string, admin bool, ops ...scopepolicy.Operation) error {
	if err := a.Validate(); err != nil {
		return err
	}
	return s.memberships.read(ctx, a.Principal, id, admin, func(store.ProjectReader, model.ProjectAccess) error { return scopeadmission.Require(a, ops...) })
}
func (s *ScopedMemberships) List(ctx context.Context, a model.CredentialAuthorization, id string) ([]model.ProjectParticipant, error) {
	out, err := s.ListWithAccess(ctx, a, id)
	return out.Items, err
}
func (s *ScopedMemberships) ListWithAccess(ctx context.Context, a model.CredentialAuthorization, id string) (core.ProjectParticipants, error) {
	if err := s.visible(ctx, a, id, false, scopepolicy.ProjectRead); err != nil {
		return core.ProjectParticipants{}, err
	}
	return s.memberships.ListWithAccess(ctx, a.Principal, id)
}
func (s *ScopedMemberships) SearchMemberCandidates(ctx context.Context, a model.CredentialAuthorization, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
	if err := a.Validate(); err != nil {
		return core.CandidatePage{}, err
	}
	if s.current == nil {
		return core.CandidatePage{}, errors.New("snapshot credential authorization unavailable")
	}
	return s.memberships.searchMemberCandidates(ctx, a.Principal, id, input, func(ctx context.Context, scope store.SnapshotScope) error {
		current, err := s.current(ctx, scope, a.Principal)
		if err != nil {
			return err
		}
		return currentAuthorization(a, current, scopepolicy.ProjectMembers)
	})
}
func (s *ScopedMemberships) SetRole(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input core.SetProjectMemberRole) (model.ProjectGrant, error) {
	if err := s.visible(ctx, a, projectID, true, scopepolicy.ProjectMembers, scopepolicy.ProjectRead); err != nil {
		return model.ProjectGrant{}, err
	}
	return s.memberships.SetRole(ctx, a.Principal, projectID, userID, input)
}
func (s *ScopedMemberships) Remove(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input core.RemoveProjectMember) error {
	if err := s.visible(ctx, a, projectID, true, scopepolicy.ProjectMembers); err != nil {
		return err
	}
	return s.memberships.Remove(ctx, a.Principal, projectID, userID, input)
}
func (s *ScopedMemberships) SetGrant(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input core.SetProjectGrant) (core.SetGrantResult, error) {
	if err := s.visible(ctx, a, projectID, true, scopepolicy.ProjectMembers, scopepolicy.ProjectRead); err != nil {
		return core.SetGrantResult{}, err
	}
	return s.memberships.SetGrant(ctx, a.Principal, projectID, userID, input)
}
func (s *ScopedMemberships) RemoveGrant(ctx context.Context, a model.CredentialAuthorization, projectID, userID string, input core.RemoveProjectMember) (core.RemoveGrantResult, error) {
	if err := s.visible(ctx, a, projectID, true, scopepolicy.ProjectMembers, scopepolicy.ProjectRead); err != nil {
		return core.RemoveGrantResult{}, err
	}
	return s.memberships.RemoveGrant(ctx, a.Principal, projectID, userID, input)
}
func (s *ScopedMemberships) CreateInvitation(ctx context.Context, a model.CredentialAuthorization, id, expected string) (core.MintedInvitation, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectInvitations); err != nil {
		return core.MintedInvitation{}, err
	}
	return s.memberships.CreateInvitation(ctx, a.Principal, id, expected)
}
func (s *ScopedMemberships) ListInvitations(ctx context.Context, a model.CredentialAuthorization, id string) ([]model.ProjectInvitation, error) {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectInvitations); err != nil {
		return nil, err
	}
	return s.memberships.ListInvitations(ctx, a.Principal, id)
}
func (s *ScopedMemberships) RevokeInvitation(ctx context.Context, a model.CredentialAuthorization, id, invitation, expected string) error {
	if err := s.visible(ctx, a, id, true, scopepolicy.ProjectInvitations); err != nil {
		return err
	}
	return s.memberships.RevokeInvitation(ctx, a.Principal, id, invitation, expected)
}
func (s *ScopedMemberships) InspectInvitation(ctx context.Context, a model.CredentialAuthorization, secret string) (core.InvitationInspection, error) {
	if err := a.Validate(); err != nil {
		return core.InvitationInspection{}, err
	}
	var result core.InvitationInspection
	err := s.memberships.inspect(ctx, a.Principal, secret, func(dao store.ProjectReader, invitation model.ProjectInvitation) error {
		if err := scopeadmission.Require(a, scopepolicy.ProjectInvitationRead, scopepolicy.ProjectRead); err != nil {
			return err
		}
		var err error
		result, err = core.InspectInvitation(ctx, dao, a.Principal, invitation)
		if err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return core.InvitationInspection{}, err
	}
	return result, nil
}

// InvitationIdentity is the invitation's own projection, without existing
// membership or Project access data.
type InvitationIdentity struct{ ProjectID, ProjectName string }

func (s *ScopedMemberships) InspectInvitationBasic(ctx context.Context, a model.CredentialAuthorization, secret string) (InvitationIdentity, error) {
	if err := a.Validate(); err != nil {
		return InvitationIdentity{}, err
	}
	var result InvitationIdentity
	err := s.memberships.inspect(ctx, a.Principal, secret, func(dao store.ProjectReader, invitation model.ProjectInvitation) error {
		if err := scopeadmission.Require(a, scopepolicy.ProjectInvitationRead); err != nil {
			return err
		}
		value, err := dao.Project(ctx, invitation.ProjectID)
		if errors.Is(err, model.ErrNotFound) {
			return model.InvitationUnavailable(err)
		}
		if err != nil {
			return err
		}
		result = InvitationIdentity{ProjectID: value.ID, ProjectName: value.Name}
		return nil
	})
	if err != nil {
		return InvitationIdentity{}, err
	}
	return result, nil
}
func (s *ScopedMemberships) AcceptInvitation(ctx context.Context, a model.CredentialAuthorization, secret, expected string) (core.InvitationAcceptance, error) {
	if err := s.admitInvitationAcceptance(ctx, a, secret, expected, scopepolicy.ProjectInvitationAccept, scopepolicy.ProjectRead); err != nil {
		return core.InvitationAcceptance{}, err
	}
	return s.memberships.AcceptInvitation(ctx, a.Principal, secret, expected)
}

// InvitationReceipt contains only facts about this acceptance operation.
type InvitationReceipt struct {
	ProjectID        string
	Joined, Consumed bool
}

func (s *ScopedMemberships) AcceptInvitationReceipt(ctx context.Context, a model.CredentialAuthorization, secret, expected string) (InvitationReceipt, error) {
	if err := s.admitInvitationAcceptance(ctx, a, secret, expected, scopepolicy.ProjectInvitationAccept); err != nil {
		return InvitationReceipt{}, err
	}
	out, err := s.memberships.AcceptInvitation(ctx, a.Principal, secret, expected)
	if err != nil {
		return InvitationReceipt{}, err
	}
	return InvitationReceipt{ProjectID: out.ProjectID, Joined: out.Joined, Consumed: out.Consumed}, nil
}

func (s *ScopedMemberships) admitInvitationAcceptance(ctx context.Context, a model.CredentialAuthorization, secret, expected string, ops ...scopepolicy.Operation) error {
	if err := a.Validate(); err != nil {
		return err
	}
	if err := core.ValidateMemberActor(a.Principal, expected); err != nil {
		return err
	}
	return s.memberships.inspect(ctx, a.Principal, secret, func(store.ProjectReader, model.ProjectInvitation) error { return scopeadmission.Require(a, ops...) })
}

type ScopedDirectMembers struct {
	members *DirectMembers
	current DirectMemberAuthorization
}

func NewScopedDirectMembers(members *DirectMembers, current DirectMemberAuthorization) *ScopedDirectMembers {
	return &ScopedDirectMembers{members: members, current: current}
}
func (s *ScopedDirectMembers) AddExistingMember(ctx context.Context, a model.CredentialAuthorization, projectID, target, expected string) (core.ExistingMemberResult, error) {
	if err := a.Validate(); err != nil {
		return core.ExistingMemberResult{}, err
	}
	if s.current == nil {
		return core.ExistingMemberResult{}, errors.New("transaction credential authorization unavailable")
	}
	return s.members.addExistingMember(ctx, a.Principal, projectID, target, expected, func(ctx context.Context, scope store.ProjectDirectMemberScope) error {
		current, err := s.current(ctx, scope, a.Principal)
		if err != nil {
			return err
		}
		return currentAuthorization(a, current, scopepolicy.ProjectMembers, scopepolicy.ProjectRead)
	})
}
