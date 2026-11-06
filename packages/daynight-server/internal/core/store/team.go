package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TeamPage struct {
	Items     []model.Team
	HasMore   bool
	Oversized *model.Team
}

// TeamMemberProfileByteLimit bounds the profile data materialized for each paged member.
const TeamMemberProfileByteLimit = 16 << 10

type TeamMemberPage struct {
	Items     []model.TeamMemberProfile
	HasMore   bool
	Oversized *model.TeamMember
}

// TeamInvitationPage is bounded by the requested page size.
type TeamInvitationPage struct {
	Items   []model.TeamInvitation
	HasMore bool
}
