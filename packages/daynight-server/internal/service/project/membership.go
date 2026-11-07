package project

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Memberships) read(ctx context.Context, p model.Principal, id string, admin bool, op func(store.ProjectReader, model.ProjectAccess) error) error {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return err
	}
	return read(ctx, s.store, func(dao store.ProjectReader) error {
		access, err := core.RequireProjectRead(ctx, dao, p, id)
		if err != nil {
			return err
		}
		if admin {
			if err := core.RequireProjectAdmin(access); err != nil {
				return err
			}
		}
		return op(dao, access)
	})
}
func (s *Memberships) writeScoped(ctx context.Context, p model.Principal, id string, op func(store.ProjectWriteDAO) error, refresh bool) error {
	id, err := core.ValidateRead(p, id)
	if err != nil {
		return err
	}
	err = writeScope(ctx, s.store, id, func(scope store.ProjectWriteScope) error {
		dao := scope.ProjectDAO()
		access, err := core.RequireProjectWrite(ctx, dao, p)
		if err != nil {
			return err
		}
		if err := core.RequireProjectAdmin(access); err != nil {
			return err
		}
		return op(dao)
	}, func(scope store.ProjectWriteScope) error {
		if refresh {
			return scope.WebhookEligibilityDAO().RefreshAffected(ctx, store.WebhookEligibilityChange{ProjectIDs: []string{id}})
		}
		return nil
	})
	return core.ProjectWriteError(err)
}
func (s *Memberships) write(ctx context.Context, p model.Principal, id string, op func(store.ProjectWriteDAO) error) error {
	return s.writeScoped(ctx, p, id, op, false)
}
func (s *Memberships) writeAccess(ctx context.Context, p model.Principal, id string, op func(store.ProjectWriteDAO) error) error {
	return s.writeScoped(ctx, p, id, op, true)
}
func (s *Memberships) List(ctx context.Context, p model.Principal, id string) ([]model.ProjectParticipant, error) {
	result, err := s.ListWithAccess(ctx, p, id)
	return result.Items, err
}
func (s *Memberships) ListWithAccess(ctx context.Context, p model.Principal, id string) (core.ProjectParticipants, error) {
	var result core.ProjectParticipants
	err := s.read(ctx, p, id, false, func(dao store.ProjectReader, access model.ProjectAccess) error {
		var err error
		result, err = core.ListParticipants(ctx, dao, id, access)
		return err
	})
	if err != nil {
		return core.ProjectParticipants{}, err
	}
	return result, nil
}
func (s *Memberships) SetRole(ctx context.Context, p model.Principal, projectID, userID string, input core.SetProjectMemberRole) (model.ProjectGrant, error) {
	if err := core.ValidateMemberActor(p, input.ExpectedUserID); err != nil {
		return model.ProjectGrant{}, err
	}
	id, err := core.ValidateMemberMutation(userID, input.Version)
	if err != nil {
		return model.ProjectGrant{}, err
	}
	if err = core.ValidateRole(input.Role); err != nil {
		return model.ProjectGrant{}, err
	}
	var result model.ProjectGrant
	err = s.writeAccess(ctx, p, projectID, func(dao store.ProjectWriteDAO) error {
		var err error
		result, err = core.SetRole(ctx, dao, id, input)
		return err
	})
	return result, err
}
func (s *Memberships) Remove(ctx context.Context, p model.Principal, projectID, userID string, input core.RemoveProjectMember) error {
	if err := core.ValidateMemberActor(p, input.ExpectedUserID); err != nil {
		return err
	}
	id, err := core.ValidateMemberMutation(userID, input.Version)
	if err != nil {
		return err
	}
	return s.writeAccess(ctx, p, projectID, func(dao store.ProjectWriteDAO) error { return core.Remove(ctx, dao, id, input) })
}
func (s *Memberships) SetGrant(ctx context.Context, p model.Principal, projectID, userID string, input core.SetProjectGrant) (core.SetGrantResult, error) {
	id, err := core.ValidateSetGrant(p, userID, input)
	if err != nil {
		return core.SetGrantResult{}, err
	}
	var result core.SetGrantResult
	err = s.writeAccess(ctx, p, projectID, func(dao store.ProjectWriteDAO) error {
		var err error
		result, err = core.SetGrant(ctx, dao, p, id, input)
		return err
	})
	return result, err
}
func (s *Memberships) RemoveGrant(ctx context.Context, p model.Principal, projectID, userID string, input core.RemoveProjectMember) (core.RemoveGrantResult, error) {
	if err := core.ValidateMemberActor(p, input.ExpectedUserID); err != nil {
		return core.RemoveGrantResult{}, err
	}
	id, err := core.ValidateMemberMutation(userID, input.Version)
	if err != nil {
		return core.RemoveGrantResult{}, err
	}
	projectID, err = model.CanonicalID(projectID)
	if err != nil {
		return core.RemoveGrantResult{}, err
	}
	var result core.RemoveGrantResult
	err = s.writeAccess(ctx, p, projectID, func(dao store.ProjectWriteDAO) error {
		var err error
		result, err = core.RemoveGrant(ctx, dao, p, projectID, id, input)
		return err
	})
	return result, err
}
func (s *Memberships) CreateInvitation(ctx context.Context, p model.Principal, id, expected string) (core.MintedInvitation, error) {
	if err := core.ValidateMemberActor(p, expected); err != nil {
		return core.MintedInvitation{}, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return core.MintedInvitation{}, err
	}
	var result core.MintedInvitation
	err = s.write(ctx, p, id, func(dao store.ProjectWriteDAO) error {
		var err error
		result, err = core.CreateInvitation(ctx, dao, p, id, s.now)
		return err
	})
	if err != nil {
		return core.MintedInvitation{}, err
	}
	result.Invitation.TokenHash = nil
	return result, nil
}
func (s *Memberships) ListInvitations(ctx context.Context, p model.Principal, id string) ([]model.ProjectInvitation, error) {
	var result []model.ProjectInvitation
	err := s.read(ctx, p, id, true, func(dao store.ProjectReader, _ model.ProjectAccess) error {
		var err error
		result, err = core.ListInvitations(ctx, dao, id, s.now)
		return err
	})
	return result, err
}
func (s *Memberships) RevokeInvitation(ctx context.Context, p model.Principal, id, inviteID, expected string) error {
	if err := core.ValidateMemberActor(p, expected); err != nil {
		return err
	}
	inviteID, err := model.CanonicalID(inviteID)
	if err != nil {
		return err
	}
	return s.write(ctx, p, id, func(dao store.ProjectWriteDAO) error { return core.RevokeInvitation(ctx, dao, inviteID, s.now) })
}
func (s *Memberships) inspect(ctx context.Context, p model.Principal, secret string, op func(store.ProjectReader, model.ProjectInvitation) error) error {
	if err := core.ValidateInvitation(p, secret); err != nil {
		return err
	}
	return read(ctx, s.store, func(dao store.ProjectReader) error {
		i, err := core.Invitation(ctx, dao, secret, s.now)
		if err != nil {
			return err
		}
		return op(dao, i)
	})
}
func (s *Memberships) InspectInvitation(ctx context.Context, p model.Principal, secret string) (core.InvitationInspection, error) {
	var result core.InvitationInspection
	err := s.inspect(ctx, p, secret, func(dao store.ProjectReader, i model.ProjectInvitation) error {
		var err error
		result, err = core.InspectInvitation(ctx, dao, p, i)
		return err
	})
	return result, err
}
func (s *Memberships) AcceptInvitation(ctx context.Context, p model.Principal, secret, expected string) (core.InvitationAcceptance, error) {
	if err := core.ValidateMemberActor(p, expected); err != nil {
		return core.InvitationAcceptance{}, err
	}
	var id string
	if err := s.inspect(ctx, p, secret, func(_ store.ProjectReader, i model.ProjectInvitation) error { id = i.ProjectID; return nil }); err != nil {
		return core.InvitationAcceptance{}, err
	}
	var result core.InvitationAcceptance
	err := writeAccess(ctx, s.store, id, func(dao store.ProjectWriteDAO) error {
		var err error
		result, err = core.AcceptInvitation(ctx, dao, p, id, secret, s.now)
		return err
	})
	if err != nil {
		return core.InvitationAcceptance{}, invitationWriteError(err)
	}
	return result, nil
}

func invitationWriteError(err error) error {
	mapped := core.ProjectWriteError(err)
	if fault, ok := mapped.(*model.Fault); ok && fault.Code == "not_found" {
		return model.InvitationUnavailable(err)
	}
	return mapped
}
