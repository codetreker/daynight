package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TeamPage struct {
	Items           []model.Team
	HasMore         bool
	OversizedTeamID string
}

// TeamMemberProfileByteLimit bounds the profile data materialized for each paged member.
const TeamMemberProfileByteLimit = 16 << 10

type TeamMemberPage struct {
	Items           []model.TeamMemberProfile
	HasMore         bool
	OversizedUserID string
}
