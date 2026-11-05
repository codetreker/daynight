package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

type UpdateProjectSettings struct {
	Version                 int64
	ExecutionWarningMinutes int32
}

func (s *Projects) UpdateSettings(ctx context.Context, principal model.Principal, projectID string, input UpdateProjectSettings) (model.Project, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Project{}, err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return model.Project{}, err
	}
	if input.Version < 1 || input.ExecutionWarningMinutes < 1 {
		return model.Project{}, invalidInput("Settings version and execution warning minutes must be positive integers.")
	}
	var project model.Project
	var refusal *model.Fault
	err = s.store.WriteProject(ctx, id, func(tx *store.ProjectTx) error {
		return completion.Capture(func() error {
			access, err := RequireProjectWrite(ctx, tx, principal)
			if err != nil {
				return err
			}
			if err := requireProjectAdmin(access); err != nil {
				return err
			}
			project, err = tx.Project(ctx)
			if err != nil {
				return err
			}
			if project.Settings.Version != input.Version {
				return &model.Fault{Code: "version_conflict", Message: "Project settings version does not match."}
			}
			if project.Settings.ExecutionWarningMinutes == input.ExecutionWarningMinutes {
				return nil
			}
			project, err = tx.UpdateProjectSettings(ctx, input.ExecutionWarningMinutes)
			return err
		}, &refusal)
	})
	if err != nil {
		return model.Project{}, membershipLookupError(err)
	}
	if refusal != nil {
		return model.Project{}, refusal
	}
	return project, nil
}
