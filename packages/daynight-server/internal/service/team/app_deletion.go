package team

import (
	"context"

	github "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

type AppTeams struct {
	*Teams
	lifecycle store.GitHubTeamDeletionStore
}

func NewAppTeams(db interface {
	store.TeamWriter
	store.SnapshotReader
	store.GitHubTeamDeletionStore
}) *AppTeams {
	return &AppTeams{Teams: NewTeams(db), lifecycle: db}
}

func (s *AppTeams) Delete(ctx context.Context, p model.Principal, id string, input core.ChangeTeam) error {
	id, err := core.ValidateChange(p, id, input)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, github.OperationTimeout)
	defer cancel()
	c, err := s.lifecycle.WriteGitHubTeamDeletion(ctx, id, func(scope store.GitHubTeamDeletionScope) error {
		dao := scope.GitHubDAO()
		grants, err := dao.LockGrants(ctx)
		if err != nil {
			return err
		}
		if err = core.Delete(ctx, scope.TeamDAO(), p, input); err != nil {
			return err
		}
		for _, g := range grants {
			if err = dao.StopGrant(ctx, g, github.DisconnectionDecision()); err != nil {
				return err
			}
			if err = dao.RevokeGrant(ctx, g); err != nil {
				return err
			}
			if err = dao.AdvanceImpact(ctx, g); err != nil {
				return err
			}
		}
		return webhook.RefreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{TeamID: id, TeamOwner: true})
	})
	return completed(c, err, nil)
}
