package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func taskWriteIdentity(principal core.Principal, projectID, taskID string, version int64) (string, string, error) {
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
		return &Fault{Code: "version_conflict", Message: "Task version does not match."}
	}
	return nil
}

func taskWriteHeader(ctx context.Context, tx *store.ProjectTx, taskID string, version int64) (core.TaskHeader, error) {
	header, err := tx.TaskHeader(ctx, taskID)
	if errors.Is(err, core.ErrNotFound) {
		return core.TaskHeader{}, taskNotFound(err)
	}
	if err != nil {
		return core.TaskHeader{}, err
	}
	if header.DeletedAt != nil {
		return core.TaskHeader{}, taskNotFound(core.ErrTaskDeleted)
	}
	return header, requireTaskVersion(header.Version, version)
}
