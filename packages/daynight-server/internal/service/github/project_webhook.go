package github

import (
	"context"
	"fmt"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ProjectWebhookManager manages the independent Project subscription configuration.
type ProjectWebhookManager struct{ db store.ProjectWriter }

func NewProjectWebhookManager(db store.ProjectWriter) *ProjectWebhookManager {
	return &ProjectWebhookManager{db: db}
}
func (m *ProjectWebhookManager) Update(ctx context.Context, p model.Principal, id string, in core.ProjectWebhookInput) (core.ProjectWebhook, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.ProjectWebhook{}, err
	}
	if err = core.ValidateProjectWebhookInput(p, in); err != nil {
		return core.ProjectWebhook{}, err
	}
	var result core.ProjectWebhook
	completion, err := m.db.WriteProject(ctx, id, func(scope store.ProjectWriteScope) error {
		var e error
		hookScope, ok := scope.(store.GitHubProjectWebhookScope)
		if !ok {
			return fmt.Errorf("project webhook write scope unavailable")
		}
		result, e = core.ManageProjectWebhook(ctx, hookScope.GitHubProjectWebhookDAO(), p, in)
		return e
	})
	if completion.Outcome == store.TransactionUnknown {
		return core.ProjectWebhook{}, &ManagementError{Code: "github_write_outcome_unknown", Message: "Project webhook write outcome is unknown; inspect the current resource before deciding what to do.", Cause: err}
	}
	if completion.Outcome == store.TransactionNotCommitted {
		if err == nil {
			return core.ProjectWebhook{}, fmt.Errorf("project webhook transaction was not committed")
		}
		return core.ProjectWebhook{}, project.ProjectWriteError(err)
	}
	if completion.Outcome != store.TransactionCommitted || err != nil {
		return core.ProjectWebhook{}, fmt.Errorf("project webhook transaction did not return a confirmed result: %w", err)
	}
	return result, nil
}

// GetWithProjectWebhook reads the connection and safe subscription in one snapshot.
func (m *ProjectAppManager) GetWithProjectWebhook(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, core.ProjectWebhook, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.ProjectAppStatus{}, core.ProjectWebhook{}, err
	}
	var status core.ProjectAppStatus
	var hook core.ProjectWebhook
	err = m.read(ctx, p, id, func(dao store.GitHubProjectAppReadDAO, facts store.GitHubProjectAppFacts) error {
		var e error
		status, e = core.ProjectAppStatusFrom(ctx, dao, facts)
		if e != nil {
			return e
		}
		reader, ok := dao.(store.GitHubProjectWebhookReadDAO)
		if !ok {
			return fmt.Errorf("project webhook reader unavailable")
		}
		hook, e = reader.ProjectWebhook(ctx)
		return e
	})
	if err != nil {
		return core.ProjectAppStatus{}, core.ProjectWebhook{}, err
	}
	return status, hook, nil
}
