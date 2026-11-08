package project

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type UpdateProjectSettings struct {
	Version                 int64
	ExecutionWarningMinutes int32
}

func ValidateSettings(p model.Principal, id string, input UpdateProjectSettings) (string, error) {
	id, err := ValidateRead(p, id)
	if err != nil {
		return "", err
	}
	if input.Version < 1 || input.ExecutionWarningMinutes < 1 {
		return "", invalidInput("Settings version and execution warning minutes must be positive integers.")
	}
	return id, nil
}
func UpdateSettings(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal, input UpdateProjectSettings) (model.Project, error) {
	access, err := RequireProjectWrite(ctx, dao, p)
	if err != nil {
		return model.Project{}, err
	}
	if err = RequireProjectAdmin(access); err != nil {
		return model.Project{}, err
	}
	value, err := dao.Project(ctx)
	if err != nil {
		return model.Project{}, err
	}
	if value.Settings.Version != input.Version {
		return model.Project{}, &model.Fault{Code: "version_conflict", Message: "Project settings version does not match."}
	}
	if value.Settings.ExecutionWarningMinutes == input.ExecutionWarningMinutes {
		return value, nil
	}
	return dao.UpdateProjectSettings(ctx, input.ExecutionWarningMinutes)
}
