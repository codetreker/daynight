package task

import (
	"context"
	"errors"
	"fmt"

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
	if err := taskcore.CheckStepsForType(header.Type); err != nil {
		return model.TaskHeader{}, err
	}
	return header, taskcore.RequireVersion(header.Version, version)
}

// PartitionDependencies combines the MCP ordinary and external sets only after
// enforcing the single complete-set limit. Core validates identities and edges.
func PartitionDependencies(ordinary, external *[]string) (*[]string, *[]string, error) {
	if ordinary == nil && external == nil {
		return nil, nil, nil
	}
	count := 0
	for _, group := range []*[]string{ordinary, external} {
		if group != nil {
			count += len(*group)
		}
	}
	if count > taskcore.MaxDependencies {
		return nil, nil, invalidInput(fmt.Sprintf("Task dependencies contain %d items; at most %d items are allowed.", count, taskcore.MaxDependencies))
	}
	all := make([]string, 0, count)
	ext := []string{}
	if ordinary != nil {
		all = append(all, (*ordinary)...)
	}
	if external != nil {
		all = append(all, (*external)...)
		ext = append(ext, (*external)...)
	}
	return &all, &ext, nil
}
