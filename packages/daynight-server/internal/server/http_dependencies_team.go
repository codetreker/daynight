package server

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

type teamOperations interface {
	Create(context.Context, model.Principal, coreteam.CreateTeam) (model.Team, error)
	Get(context.Context, model.Principal, string) (model.Team, error)
	List(context.Context, model.Principal, model.PageRequest) (coreteam.TeamPage, error)
	Rename(context.Context, model.Principal, string, coreteam.ChangeTeam) (model.Team, error)
	Delete(context.Context, model.Principal, string, coreteam.ChangeTeam) error
	Members(context.Context, model.Principal, string) ([]model.TeamMemberProfile, error)
	SetMemberRole(context.Context, model.Principal, string, string, coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error)
	RemoveMember(context.Context, model.Principal, string, string, coreteam.ChangeTeamMember) (coreteam.TeamMemberResult, error)
	CreateInvitation(context.Context, model.Principal, string, string) (coreteam.MintedTeamInvitation, error)
	ListInvitations(context.Context, model.Principal, string) ([]model.TeamInvitation, error)
	RevokeInvitation(context.Context, model.Principal, string, string, string) (bool, error)
	InspectInvitation(context.Context, model.Principal, string) (coreteam.TeamInvitationInspection, error)
	AcceptInvitation(context.Context, model.Principal, string, string) (coreteam.TeamInvitationAcceptance, error)
}
