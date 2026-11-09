package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) SetStatus(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.SetTaskStatus) (model.Task, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return model.Task{}, err
	}
	id, err = model.CanonicalID(id)
	if err != nil {
		return model.Task{}, err
	}
	input, err = taskcore.ValidateStatus(input)
	if err != nil {
		return model.Task{}, err
	}
	return s.write(ctx, principal, projectID, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		mutation, err := taskcore.PrepareStatus(ctx, tx.TaskDAO(), principal, id, input)
		return mutation, err
	})
}
