package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"testing"
)

type operationRejectedMemberships struct{ t *testing.T }

func (r *operationRejectedMemberships) ListWithAccess(context.Context, model.Principal, string) (projectcore.ProjectParticipants, error) {
	r.t.Errorf("unexpected Memberships.ListWithAccess call")
	var result0 projectcore.ProjectParticipants
	return result0, errors.New("unexpected Memberships.ListWithAccess")
}

func (r *operationRejectedMemberships) SetRole(context.Context, model.Principal, string, string, projectcore.SetProjectMemberRole) (model.ProjectGrant, error) {
	r.t.Errorf("unexpected Memberships.SetRole call")
	var result0 model.ProjectGrant
	return result0, errors.New("unexpected Memberships.SetRole")
}

func (r *operationRejectedMemberships) Remove(context.Context, model.Principal, string, string, projectcore.RemoveProjectMember) error {
	r.t.Errorf("unexpected Memberships.Remove call")
	return errors.New("unexpected Memberships.Remove")
}

func (r *operationRejectedMemberships) SetGrant(context.Context, model.Principal, string, string, projectcore.SetProjectGrant) (projectcore.SetGrantResult, error) {
	r.t.Errorf("unexpected Memberships.SetGrant call")
	var result0 projectcore.SetGrantResult
	return result0, errors.New("unexpected Memberships.SetGrant")
}

func (r *operationRejectedMemberships) RemoveGrant(context.Context, model.Principal, string, string, projectcore.RemoveProjectMember) (projectcore.RemoveGrantResult, error) {
	r.t.Errorf("unexpected Memberships.RemoveGrant call")
	var result0 projectcore.RemoveGrantResult
	return result0, errors.New("unexpected Memberships.RemoveGrant")
}

func (r *operationRejectedMemberships) CreateInvitation(context.Context, model.Principal, string, string) (projectcore.MintedInvitation, error) {
	r.t.Errorf("unexpected Memberships.CreateInvitation call")
	var result0 projectcore.MintedInvitation
	return result0, errors.New("unexpected Memberships.CreateInvitation")
}

func (r *operationRejectedMemberships) ListInvitations(context.Context, model.Principal, string) ([]model.ProjectInvitation, error) {
	r.t.Errorf("unexpected Memberships.ListInvitations call")
	var result0 []model.ProjectInvitation
	return result0, errors.New("unexpected Memberships.ListInvitations")
}

func (r *operationRejectedMemberships) RevokeInvitation(context.Context, model.Principal, string, string, string) error {
	r.t.Errorf("unexpected Memberships.RevokeInvitation call")
	return errors.New("unexpected Memberships.RevokeInvitation")
}

func (r *operationRejectedMemberships) InspectInvitation(context.Context, model.Principal, string) (projectcore.InvitationInspection, error) {
	r.t.Errorf("unexpected Memberships.InspectInvitation call")
	var result0 projectcore.InvitationInspection
	return result0, errors.New("unexpected Memberships.InspectInvitation")
}

func (r *operationRejectedMemberships) AcceptInvitation(context.Context, model.Principal, string, string) (projectcore.InvitationAcceptance, error) {
	r.t.Errorf("unexpected Memberships.AcceptInvitation call")
	var result0 projectcore.InvitationAcceptance
	return result0, errors.New("unexpected Memberships.AcceptInvitation")
}
