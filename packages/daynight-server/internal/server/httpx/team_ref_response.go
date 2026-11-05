package httpx

import (
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TeamRefResponse(team model.TeamRef) api.TeamRef {
	return api.TeamRef{ID: team.ID, Kind: team.Kind, Name: team.Name}
}
