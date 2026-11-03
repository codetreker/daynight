package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

func currentTaskWrite(current core.Task) store.TaskWrite {
	return store.TaskWrite{
		AssignedTo: current.AssignedTo, RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents,
		Title: current.Title, Description: current.Description, Properties: taskproperties.Clone(current.Properties),
		Status: current.Status, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn,
	}
}

func canonicalAssignedTo(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	canonical, err := CanonicalID(*value)
	if err != nil {
		return nil, err
	}
	return &canonical, nil
}

func taskWriteFault(err error) *Fault {
	var fault *Fault
	if errors.As(err, &fault) {
		return fault
	}
	return propertyValidationFault(err)
}

func enforceAssignmentTransition(ctx context.Context, tx *store.ProjectTx, mutation taskMutation) (taskMutation, error) {
	if equalOptional(mutation.current.AssignedTo, mutation.values.AssignedTo) {
		return mutation, nil
	}
	if mutation.current.Status == core.TaskInProgress {
		return taskMutation{}, &Fault{Code: "invalid_transition", Message: "Task assignment cannot change while the task is in progress."}
	}
	if mutation.values.AssignedTo != nil {
		if _, err := tx.DirectProjectMember(ctx, *mutation.values.AssignedTo); err != nil {
			if errors.Is(err, core.ErrNotFound) {
				return taskMutation{}, &Fault{Code: "invalid_input", Message: "Assigned user must have access to the project.", Cause: err}
			}
			return taskMutation{}, err
		}
	}
	mutation.values.AllowAgents = false
	return mutation, nil
}
