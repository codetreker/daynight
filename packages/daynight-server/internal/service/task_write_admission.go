package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func taskWriteIdentity(principal model.Principal, projectID, taskID string, version int64) (string, string, error) {
	if err := requirePrincipal(principal); err != nil {
		return "", "", err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return "", "", err
	}
	taskID, err = CanonicalID(taskID)
	if err != nil {
		return "", "", err
	}
	if version < 1 {
		return "", "", invalidInput("Version must be a positive integer.")
	}
	return projectID, taskID, nil
}

func requireTaskVersion(current, observed int64) error {
	if current != observed {
		return &model.Fault{Code: "version_conflict", Message: "Task version does not match."}
	}
	return nil
}

func taskWriteHeader(ctx context.Context, tx *store.ProjectTx, taskID string, version int64) (model.TaskHeader, error) {
	header, err := tx.TaskHeader(ctx, taskID)
	if errors.Is(err, model.ErrNotFound) {
		return model.TaskHeader{}, taskNotFound(err)
	}
	if err != nil {
		return model.TaskHeader{}, err
	}
	if header.DeletedAt != nil {
		return model.TaskHeader{}, taskNotFound(model.ErrTaskDeleted)
	}
	return header, requireTaskVersion(header.Version, version)
}
