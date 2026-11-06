package task

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func taskWriteIdentity(principal model.Principal, projectID, taskID string, version int64) (string, string, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return "", "", err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return "", "", err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return "", "", err
	}
	if version < 1 {
		return "", "", invalidInput("Version must be a positive integer.")
	}
	return projectID, taskID, nil
}

func taskWriteHeader(ctx context.Context, tx store.ProjectWriteScope, taskID string, version int64) (model.TaskHeader, error) {
	header, err := tx.TaskDAO().TaskHeader(ctx, taskID)
	if errors.Is(err, model.ErrNotFound) {
		return model.TaskHeader{}, taskcore.NotFound(err)
	}
	if err != nil {
		return model.TaskHeader{}, err
	}
	if header.DeletedAt != nil {
		return model.TaskHeader{}, taskcore.NotFound(model.ErrTaskDeleted)
	}
	return header, taskcore.RequireVersion(header.Version, version)
}
