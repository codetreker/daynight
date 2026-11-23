package task

import (
	"context"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func (s *Tasks) Delete(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.DeleteTask) error {
	projectID, id, err := taskWriteIdentity(principal, projectID, id, input.Version)
	if err != nil {
		return err
	}
	ctx = withTaskWriteOperations(ctx, scopepolicy.TaskDelete)
	ctx, cancel, goal, err := s.lifecycleContext(ctx, principal, projectID, id)
	if err != nil {
		return err
	}
	defer cancel()
	ctx = withTaskWriteTarget(ctx, id, goal)
	_, err = s.versionedWriteTaggedWithLocks(ctx, principal, projectID, id, input.Version, nil, goal, false, &input.RemoveDepends, func(tx store.ProjectWriteScope, current model.Task) (taskcore.Mutation, error) {
		if (current.Type == model.TaskTypeGoal) != goal {
			return taskcore.Mutation{}, fmt.Errorf("lifecycle target type changed")
		}
		mutation, err := taskcore.PrepareDelete(ctx, tx.TaskDAO(), current, input.RemoveDepends)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if goal {
			if err := taskcore.ValidateGoalDeletion(ctx, tx.GoalDependencyDAO(), current.ID); err != nil {
				return taskcore.Mutation{}, err
			}
		}
		return mutation, nil
	})
	return goalLifecycleError(err, goal)
}
