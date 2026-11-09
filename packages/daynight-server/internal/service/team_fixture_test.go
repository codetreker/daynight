package service

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func newTestTeam(t *testing.T, teams *teamservice.Teams, p model.Principal, name string) model.Team {
	t.Helper()
	team, err := teams.Create(context.Background(), p, coreteam.CreateTeam{Name: name, ExpectedUserID: p.UserID})
	if err != nil {
		t.Fatal(err)
	}
	return team
}
