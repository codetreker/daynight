package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// GoalDependencyFacts are read while the owning Team's dependency lock is held.
type GoalDependencyFacts interface {
	UnsatisfiedPrerequisites(context.Context, string) (bool, error)
	DoneSuccessors(context.Context, string) (bool, error)
	HasIncoming(context.Context, string) (bool, error)
}

// ValidateGoalStatus enforces acceptance dependencies without disclosing endpoints.
func ValidateGoalStatus(ctx context.Context, facts GoalDependencyFacts, current model.Task, status model.TaskStatus) error {
	if current.Status == status {
		return nil
	}
	if status == model.TaskDone {
		blocked, err := facts.UnsatisfiedPrerequisites(ctx, current.ID)
		if err != nil {
			return err
		}
		if blocked {
			return &model.Fault{Code: "goal_dependency_unsatisfied", Message: "Goal prerequisites must be done before completion."}
		}
	}
	if current.Status == model.TaskDone {
		blocked, err := facts.DoneSuccessors(ctx, current.ID)
		if err != nil {
			return err
		}
		if blocked {
			return &model.Fault{Code: "goal_dependency_done_successor", Message: "A completed Goal still depends on this Goal."}
		}
	}
	return nil
}

// ValidateGoalDeletion refuses deletion while any live Goal refers to it.
func ValidateGoalDeletion(ctx context.Context, facts GoalDependencyFacts, goalID string) error {
	referenced, err := facts.HasIncoming(ctx, goalID)
	if err != nil {
		return err
	}
	if referenced {
		return &model.Fault{Code: "goal_dependency_referenced", Message: "Remove Goal references before deleting this Goal."}
	}
	return nil
}
