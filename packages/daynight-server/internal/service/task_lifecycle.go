package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
)

type SetTaskStatus struct {
	Version int64
	Status  model.TaskStatus
	ClaimID *string
}

func (s *Tasks) SetStatus(ctx context.Context, principal model.Principal, projectID, id string, input SetTaskStatus) (model.Task, error) {
	if err := requirePrincipal(principal); err != nil {
		return model.Task{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return model.Task{}, err
	}
	id, err = CanonicalID(id)
	if err != nil {
		return model.Task{}, err
	}
	if input.Version < 1 {
		return model.Task{}, invalidInput("Version must be a positive integer.")
	}
	if !input.Status.Valid() {
		return model.Task{}, invalidInput("Task status is invalid.")
	}
	if input.ClaimID != nil {
		if input.Status != model.TaskDone {
			return model.Task{}, invalidInput("A worker claim may only accompany completion.")
		}
		claimID, err := CanonicalID(*input.ClaimID)
		if err != nil {
			return model.Task{}, err
		}
		input.ClaimID = &claimID
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) (taskMutation, error) {
		current, err := tx.Task(ctx, id)
		if errors.Is(err, model.ErrNotFound) {
			return taskMutation{}, taskNotFound(err)
		}
		if err != nil {
			return taskMutation{}, err
		}
		if current.Version != input.Version {
			return taskMutation{}, &model.Fault{Code: "version_conflict", Message: "Task version does not match."}
		}
		worker, err := taskproperties.Worker(current.Properties)
		if err != nil {
			return taskMutation{}, err
		}
		if err := requireCompatibleWorker(ctx, worker); err != nil {
			return taskMutation{}, err
		}
		if current.Status == input.Status {
			return taskMutation{current: current}, nil
		}
		if (input.Status == model.TaskInProgress || input.Status == model.TaskDone) && len(current.BlockedBy) > 0 {
			return taskMutation{}, &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done.", TaskIDs: current.BlockedBy}
		}
		if current.Status == model.TaskDone {
			dependents, err := tx.ActiveDependentIDs(ctx, id)
			if err != nil {
				return taskMutation{}, err
			}
			if len(dependents) > 0 {
				return taskMutation{}, &model.Fault{Code: "dependency_unsatisfied", Message: "Task dependents must return to todo before reopening this prerequisite.", TaskIDs: dependents}
			}
		}
		values := currentTaskWrite(current)
		if worker != nil && worker.State == model.WorkerActive {
			if input.Status != model.TaskDone {
				return taskMutation{}, &model.Fault{Code: "invalid_transition", Message: "Active worker execution must be stopped through release."}
			}
			if input.ClaimID == nil || *input.ClaimID != worker.ClaimID {
				return taskMutation{}, claimConflict()
			}
			if worker.UserID != principal.UserID {
				return taskMutation{}, &model.Fault{Code: "forbidden", Message: "Only the current execution owner may complete worker execution."}
			}
			next := *worker
			next.State = model.WorkerCompleted
			values.Properties, err = taskproperties.WithWorker(values.Properties, &next)
			if err != nil {
				return taskMutation{}, err
			}
		} else {
			if input.ClaimID != nil {
				return taskMutation{}, claimConflict()
			}
			if worker != nil && worker.State == model.WorkerReleased {
				return taskMutation{}, &model.Fault{Code: "invalid_transition", Message: "Released worker execution requires a controlled continuation of its original worktree."}
			}
		}
		values.Status = input.Status
		return taskMutation{id: id, current: current, values: values, changed: true}, nil
	})
}
