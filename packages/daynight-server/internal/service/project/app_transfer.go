package project

import (
	"context"
	"log/slog"

	github "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	session "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

// AppProjects retains ordinary project operations and supplies App-aware
// transfer and deletion coordinators for the application composition root.
type AppProjects struct {
	*Projects
	lifecycle          store.GitHubProjectLifecycleStore
	repositoryStore    store.ProjectRepositoryStore
	repositoryObserver RepositoryObserver
	repositoryLogger   *slog.Logger
}

func NewAppProjects(db interface {
	database
	store.GitHubProjectLifecycleStore
}, engines ...*session.Engine) *AppProjects {
	repositories, _ := any(db).(store.ProjectRepositoryStore)
	return &AppProjects{Projects: NewProjects(db, engines...), lifecycle: db, repositoryStore: repositories, repositoryLogger: slog.Default()}
}

func (s *AppProjects) Transfer(ctx context.Context, p model.Principal, id string, input core.TransferInput) (core.TransferReceipt, error) {
	id, source, target, err := core.ValidateTransfer(p, id, input)
	if err != nil {
		return core.TransferReceipt{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, projectLifecycleTimeout)
	defer cancel()
	access, err := s.Access(ctx, p, id)
	if err != nil {
		return core.TransferReceipt{}, err
	}
	if err = ownerAdmin(access); err != nil {
		return core.TransferReceipt{}, err
	}
	var result core.TransferReceipt
	c, err := s.lifecycle.WriteGitHubProjectTransfer(ctx, id, func(scope store.GitHubProjectTransferScope) error {
		var err error
		result, err = core.Transfer(ctx, scope.ProjectDAO(), p, id, source, target, input)
		if err != nil {
			return err
		}
		if result.Changed {
			if err = taskcore.RemoveProjectGoalDependencies(ctx, scope.ProjectGoalDependencyDAO(), input.ConfirmGoalDependencyRemoval); err != nil {
				return err
			}
			dao := scope.GitHubDAO()
			if _, err = dao.LockBinding(ctx); err != nil {
				return err
			}
			if err = dao.Stop(ctx, github.DisconnectionDecision()); err != nil {
				return err
			}
			if err = dao.AdvanceImpact(ctx); err != nil {
				return err
			}
		}
		return webhook.RefreshEligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{ProjectID: id})
	})
	if err := completed(c, err, nil); err != nil {
		return core.TransferReceipt{}, err
	}
	return result, nil
}
