package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TeamPage struct {
	Items   []model.Team
	HasMore bool
}

// TeamInvitationPage is bounded by the requested page size.
type TeamInvitationPage struct {
	Items   []model.TeamInvitation
	HasMore bool
}
