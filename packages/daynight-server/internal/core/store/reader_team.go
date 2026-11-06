package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TeamReader interface {
	Team(context.Context, string, string) (model.Team, error)
	TeamBounded(context.Context, string, string, int) (model.Team, bool, error)
	TeamsBounded(context.Context, string, Page, int) (TeamPage, error)
	TeamAccess(context.Context, string, string) error
	Teams(context.Context, string, Page) (TeamPage, error)
	TeamMembers(context.Context, string) ([]model.TeamMemberProfile, error)
	TeamMembersPage(context.Context, string, Page) (TeamMemberPage, error)
	TeamInvitation(context.Context, []byte) (model.TeamInvitation, error)
	TeamInvitations(context.Context, string, time.Time) ([]model.TeamInvitation, error)
	InvitationTeam(context.Context, string) (model.TeamRef, error)
	InvitationTeamMember(context.Context, string, string) (model.TeamMember, error)
}
