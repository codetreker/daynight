package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type TeamPage struct {
	Items   []model.Team
	HasMore bool
}
