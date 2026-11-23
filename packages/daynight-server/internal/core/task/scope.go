package task

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

// CreateOperations classifies the explicit, non-default creation choices.
func CreateOperations(input CreateTask, actor model.Principal) []scopepolicy.Operation {
	ops := []scopepolicy.Operation{scopepolicy.TaskWrite}
	defaultAssigned := input.DefaultAssignedTo
	if input.Type == model.TaskTypeGoal {
		defaultAssigned = &actor.UserID
	}
	assigned, assignedErr := canonicalAssignedTo(input.AssignedTo)
	defaultID, defaultErr := canonicalAssignedTo(defaultAssigned)
	if input.AssignedToPresent && (assignedErr != nil || defaultErr != nil || !model.EqualOptional(assigned, defaultID)) || input.RequiredPlatform != nil {
		ops = append(ops, scopepolicy.TaskAssign)
	}
	if input.ParentID != nil || input.ParentTaskID != nil || len(input.DependsOn) != 0 || len(input.ExternalDependsOn) != 0 {
		ops = append(ops, scopepolicy.TaskDependencies)
	}
	defaultStatus := model.TaskProposed
	if input.Type == model.TaskTypeGoal {
		defaultStatus = model.TaskTodo
	}
	if input.Status != nil && *input.Status != defaultStatus {
		ops = append(ops, scopepolicy.TaskStatus)
	}
	for name := range input.Properties {
		if properties.CanonicalName(name) == "blocked" {
			ops = append(ops, scopepolicy.TaskStatus)
		}
	}
	return ops
}

// UpdateOperations classifies fields by presence, including explicit nulls.
func UpdateOperations(input UpdateTask) []scopepolicy.Operation {
	var ops []scopepolicy.Operation
	if input.Title != nil || input.Description != nil || input.TagIDs != nil {
		ops = append(ops, scopepolicy.TaskWrite)
	}
	if input.AssignedTo != nil || input.RequiredPlatform != nil {
		ops = append(ops, scopepolicy.TaskAssign)
	}
	if input.ParentID != nil || input.DependsOn != nil || input.ExternalDependsOn != nil {
		ops = append(ops, scopepolicy.TaskDependencies)
	}
	if input.AllowAgents != nil {
		ops = append(ops, scopepolicy.AgentAuthorize)
	}
	for name := range input.Properties {
		ops = append(ops, PropertyOperation(name))
	}
	return ops
}

func PropertyOperation(name string) scopepolicy.Operation {
	if properties.CanonicalName(name) == "blocked" {
		return scopepolicy.TaskStatus
	}
	return scopepolicy.TaskWrite
}

func StatusOperation(input SetTaskStatus) scopepolicy.Operation {
	if input.ClaimID != nil {
		return scopepolicy.WorkerComplete
	}
	return scopepolicy.TaskStatus
}
