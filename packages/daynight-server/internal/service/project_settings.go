package service

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type UpdateProjectSettings struct {
	Version                 int64
	ExecutionWarningMinutes int32
}

func (s *Projects) UpdateSettings(ctx context.Context, principal core.Principal, projectID string, input UpdateProjectSettings) (core.Project, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Project{}, err
	}
	id, err := CanonicalID(projectID)
	if err != nil {
		return core.Project{}, err
	}
	if input.Version < 1 || input.ExecutionWarningMinutes < 1 {
		return core.Project{}, invalidInput("Settings version and execution warning minutes must be positive integers.")
	}
	var project core.Project
	var refusal *Fault
	err = s.store.WriteProject(ctx, id, func(tx *store.ProjectTx) error {
		return completeMembershipOperation(func() error {
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
				return &Fault{Code: "version_conflict", Message: "Project settings version does not match."}
			}
			if project.Settings.ExecutionWarningMinutes == input.ExecutionWarningMinutes {
				return nil
			}
			project, err = tx.UpdateProjectSettings(ctx, input.ExecutionWarningMinutes)
			return err
		}, &refusal)
	})
	if err != nil {
		return core.Project{}, membershipLookupError(err)
	}
	if refusal != nil {
		return core.Project{}, refusal
	}
	return project, nil
}
