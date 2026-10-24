package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type SetTaskStatus struct {
	Version int64
	Status  core.TaskStatus
	ClaimID *string
}

func (s *Tasks) SetStatus(ctx context.Context, principal core.Principal, projectID, id string, input SetTaskStatus) (core.Task, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Task{}, err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return core.Task{}, err
	}
	id, err = CanonicalID(id)
	if err != nil {
		return core.Task{}, err
	}
	if input.Version < 1 {
		return core.Task{}, invalidInput("Version must be a positive integer.")
	}
	if !input.Status.Valid() {
		return core.Task{}, invalidInput("Task status is invalid.")
	}
	if input.ClaimID != nil {
		if input.Status != core.TaskDone {
			return core.Task{}, invalidInput("A worker claim may only accompany completion.")
		}
		claimID, err := CanonicalID(*input.ClaimID)
		if err != nil {
			return core.Task{}, err
		}
		input.ClaimID = &claimID
	}
	return s.write(ctx, principal, projectID, func(tx *store.ProjectTx) (taskMutation, error) {
		current, err := tx.Task(ctx, id)
		if errors.Is(err, core.ErrNotFound) {
			return taskMutation{}, taskNotFound(err)
		}
		if err != nil {
			return taskMutation{}, err
		}
		if current.Version != input.Version {
			return taskMutation{}, &Fault{Code: "version_conflict", Message: "Task version does not match."}
		}
		if current.Status == input.Status {
			return taskMutation{current: current}, nil
		}
		if (input.Status == core.TaskInProgress || input.Status == core.TaskDone) && len(current.BlockedBy) > 0 {
			return taskMutation{}, &Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done.", TaskIDs: current.BlockedBy}
		}
		if current.Status == core.TaskDone {
			dependents, err := tx.ActiveDependentIDs(ctx, id)
			if err != nil {
				return taskMutation{}, err
			}
			if len(dependents) > 0 {
				return taskMutation{}, &Fault{Code: "dependency_unsatisfied", Message: "Task dependents must return to todo before reopening this prerequisite.", TaskIDs: dependents}
			}
		}
		values := currentTaskWrite(current)
		worker := current.Properties.Worker
		if worker != nil && worker.State == core.WorkerActive {
			if input.Status != core.TaskDone {
				return taskMutation{}, &Fault{Code: "invalid_transition", Message: "Active worker execution must be stopped through release."}
			}
			if input.ClaimID == nil || *input.ClaimID != worker.ClaimID {
				return taskMutation{}, claimConflict()
			}
			if worker.UserID != principal.UserID {
				return taskMutation{}, &Fault{Code: "forbidden", Message: "Only the current execution owner may complete worker execution."}
			}
			next := *worker
			next.State = core.WorkerCompleted
			values.Properties.Worker = &next
		} else {
			if input.ClaimID != nil {
				return taskMutation{}, claimConflict()
			}
			if worker != nil && worker.State == core.WorkerReleased {
				return taskMutation{}, &Fault{Code: "invalid_transition", Message: "Released worker execution requires a controlled continuation of its original worktree."}
			}
		}
		values.Status = input.Status
		return taskMutation{id: id, current: current, values: values, changed: true}, nil
	})
}
