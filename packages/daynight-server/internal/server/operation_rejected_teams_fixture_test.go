package server

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"testing"
)

type operationRejectedTeams struct{ t *testing.T }

func (r *operationRejectedTeams) Create(context.Context, model.Principal, teamcore.CreateTeam) (model.Team, error) {
	r.t.Errorf("unexpected Teams.Create call")
	var result0 model.Team
	return result0, errors.New("unexpected Teams.Create")
}

func (r *operationRejectedTeams) Get(context.Context, model.Principal, string) (model.Team, error) {
	r.t.Errorf("unexpected Teams.Get call")
	var result0 model.Team
	return result0, errors.New("unexpected Teams.Get")
}

func (r *operationRejectedTeams) List(context.Context, model.Principal, model.PageRequest) (teamcore.TeamPage, error) {
	r.t.Errorf("unexpected Teams.List call")
	var result0 teamcore.TeamPage
	return result0, errors.New("unexpected Teams.List")
}

func (r *operationRejectedTeams) Rename(context.Context, model.Principal, string, teamcore.ChangeTeam) (model.Team, error) {
	r.t.Errorf("unexpected Teams.Rename call")
	var result0 model.Team
	return result0, errors.New("unexpected Teams.Rename")
}

func (r *operationRejectedTeams) Delete(context.Context, model.Principal, string, teamcore.ChangeTeam) error {
	r.t.Errorf("unexpected Teams.Delete call")
	return errors.New("unexpected Teams.Delete")
}

func (r *operationRejectedTeams) Members(context.Context, model.Principal, string) ([]model.TeamMemberProfile, error) {
	r.t.Errorf("unexpected Teams.Members call")
	var result0 []model.TeamMemberProfile
	return result0, errors.New("unexpected Teams.Members")
}

func (r *operationRejectedTeams) MembersPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.MemberPage, error) {
	r.t.Errorf("unexpected Teams.MembersPage call")
	var result0 teamcore.MemberPage
	return result0, errors.New("unexpected Teams.MembersPage")
}

func (r *operationRejectedTeams) Member(context.Context, model.Principal, string, string) (model.TeamMember, error) {
	r.t.Errorf("unexpected Teams.Member call")
	var result0 model.TeamMember
	return result0, errors.New("unexpected Teams.Member")
}

func (r *operationRejectedTeams) SetMemberRole(context.Context, model.Principal, string, string, teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
	r.t.Errorf("unexpected Teams.SetMemberRole call")
	var result0 teamcore.TeamMemberResult
	return result0, errors.New("unexpected Teams.SetMemberRole")
}

func (r *operationRejectedTeams) RemoveMember(context.Context, model.Principal, string, string, teamcore.ChangeTeamMember) (teamcore.TeamMemberResult, error) {
	r.t.Errorf("unexpected Teams.RemoveMember call")
	var result0 teamcore.TeamMemberResult
	return result0, errors.New("unexpected Teams.RemoveMember")
}

func (r *operationRejectedTeams) CreateInvitation(context.Context, model.Principal, string, string) (teamcore.MintedTeamInvitation, error) {
	r.t.Errorf("unexpected Teams.CreateInvitation call")
	var result0 teamcore.MintedTeamInvitation
	return result0, errors.New("unexpected Teams.CreateInvitation")
}

func (r *operationRejectedTeams) ListInvitations(context.Context, model.Principal, string) ([]model.TeamInvitation, error) {
	r.t.Errorf("unexpected Teams.ListInvitations call")
	var result0 []model.TeamInvitation
	return result0, errors.New("unexpected Teams.ListInvitations")
}

func (r *operationRejectedTeams) ListInvitationPage(context.Context, model.Principal, string, model.PageRequest) (teamcore.InvitationPage, error) {
	r.t.Errorf("unexpected Teams.ListInvitationPage call")
	var result0 teamcore.InvitationPage
	return result0, errors.New("unexpected Teams.ListInvitationPage")
}

func (r *operationRejectedTeams) RevokeInvitation(context.Context, model.Principal, string, string, string) (bool, error) {
	r.t.Errorf("unexpected Teams.RevokeInvitation call")
	var result0 bool
	return result0, errors.New("unexpected Teams.RevokeInvitation")
}

func (r *operationRejectedTeams) InspectInvitation(context.Context, model.Principal, string) (teamcore.TeamInvitationInspection, error) {
	r.t.Errorf("unexpected Teams.InspectInvitation call")
	var result0 teamcore.TeamInvitationInspection
	return result0, errors.New("unexpected Teams.InspectInvitation")
}

func (r *operationRejectedTeams) AcceptInvitation(context.Context, model.Principal, string, string) (teamcore.TeamInvitationAcceptance, error) {
	r.t.Errorf("unexpected Teams.AcceptInvitation call")
	var result0 teamcore.TeamInvitationAcceptance
	return result0, errors.New("unexpected Teams.AcceptInvitation")
}
