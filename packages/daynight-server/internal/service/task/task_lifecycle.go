package task

import (
	"context"
	"fmt"

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
	ctx = withTaskWriteOperations(ctx, taskcore.StatusOperation(input))
	ctx, cancel, goal, err := s.lifecycleContext(ctx, principal, projectID, id)
	if err != nil {
		return model.Task{}, err
	}
	defer cancel()
	ctx = withTaskWriteTarget(ctx, id, goal)
	result, err := s.write(ctx, principal, projectID, func(tx store.ProjectWriteScope) (taskcore.Mutation, error) {
		if goal && !scopedGoalLocked(ctx) {
			if err := tx.GoalDependencyDAO().LockTeam(ctx); err != nil {
				return taskcore.Mutation{}, err
			}
			if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
				return taskcore.Mutation{}, err
			}
		}
		mutation, err := s.writeOperations.prepareStatus(ctx, tx.TaskDAO(), principal, id, input)
		if err != nil {
			return taskcore.Mutation{}, err
		}
		if (mutation.Current.Type == model.TaskTypeGoal) != goal {
			return taskcore.Mutation{}, fmt.Errorf("lifecycle target type changed")
		}
		if goal {
			if err := taskcore.ValidateGoalStatus(ctx, tx.GoalDependencyDAO(), mutation.Current, input.Status); err != nil {
				return taskcore.Mutation{}, err
			}
		}
		return mutation, nil
	})
	return result, goalLifecycleError(err, goal)
}
