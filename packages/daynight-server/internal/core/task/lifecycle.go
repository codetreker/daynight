package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

type SetTaskStatus struct {
	Version int64
	Status  model.TaskStatus
	ClaimID *string
}

type DeleteTask struct {
	Version       int64
	RemoveDepends bool
}

func ValidateStatus(input SetTaskStatus) (SetTaskStatus, error) {
	if input.Version < 1 {
		return input, invalidInput("Version must be a positive integer.")
	}
	if !input.Status.Valid() {
		return input, invalidInput("Task status is invalid.")
	}
	if input.ClaimID != nil {
		if input.Status != model.TaskDone {
			return input, invalidInput("A worker claim may only accompany completion.")
		}
		claimID, err := model.CanonicalID(*input.ClaimID)
		if err != nil {
			return input, err
		}
		input.ClaimID = &claimID
	}
	return input, nil
}

// StatusCandidate requires the current Task and compatible claim to be read under
// the project write lock. A false changed result preserves a same-status no-op.
func StatusCandidate(ctx context.Context, dao store.TaskWriteDAO, principal model.Principal, current model.Task, input SetTaskStatus, worker *model.WorkerClaim) (store.TaskWrite, bool, error) {
	if current.Status == input.Status {
		return store.TaskWrite{}, false, nil
	}
	if (input.Status == model.TaskInProgress || input.Status == model.TaskDone) && len(current.BlockedBy) > 0 {
		return store.TaskWrite{}, false, &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done.", TaskIDs: current.BlockedBy}
	}
	if current.Status == model.TaskDone {
		dependents, err := dao.ActiveDependentIDs(ctx, current.ID)
		if err != nil {
			return store.TaskWrite{}, false, err
		}
		if len(dependents) > 0 {
			return store.TaskWrite{}, false, &model.Fault{Code: "dependency_unsatisfied", Message: "Task dependents must return to todo before reopening this prerequisite.", TaskIDs: dependents}
		}
	}
	values := CurrentWrite(current)
	if worker != nil && worker.State == model.WorkerActive {
		if input.Status != model.TaskDone {
			return store.TaskWrite{}, false, &model.Fault{Code: "invalid_transition", Message: "Active worker execution must be stopped through release."}
		}
		if input.ClaimID == nil || *input.ClaimID != worker.ClaimID {
			return store.TaskWrite{}, false, ClaimConflict()
		}
		if worker.UserID != principal.UserID {
			return store.TaskWrite{}, false, &model.Fault{Code: "forbidden", Message: "Only the current execution owner may complete worker execution."}
		}
		next := *worker
		next.State = model.WorkerCompleted
		var err error
		values.Properties, err = properties.WithWorker(values.Properties, &next)
		if err != nil {
			return store.TaskWrite{}, false, err
		}
	} else {
		if input.ClaimID != nil {
			return store.TaskWrite{}, false, ClaimConflict()
		}
		if worker != nil && worker.State == model.WorkerReleased {
			return store.TaskWrite{}, false, &model.Fault{Code: "invalid_transition", Message: "Released worker execution requires a controlled continuation of its original worktree."}
		}
	}
	values.Status = input.Status
	return values, true, nil
}

func ClaimConflict() error {
	return &model.Fault{Code: "claim_conflict", Message: "Task worker claim does not match the active execution."}
}

func ValidateDelete(ctx context.Context, dao store.TaskWriteDAO, current model.Task, removeDepends bool) error {
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return err
	}
	if worker != nil && worker.State == model.WorkerActive {
		return &model.Fault{Code: "invalid_transition", Message: "Release the active worker execution before deleting the task."}
	}
	if !removeDepends {
		dependents, err := dao.DependentIDs(ctx, current.ID)
		if err != nil {
			return err
		}
		if len(dependents) > 0 {
			return &model.Fault{Code: "dependency_unsatisfied", Message: "Remove dependent task relationships before deleting the task.", TaskIDs: dependents}
		}
	}
	return nil
}

// AssignmentChanged validates the Task-owned state rule. The caller must verify
// project access for a new assignee before applying AssignmentValues.
func AssignmentChanged(current model.Task, values store.TaskWrite) (bool, error) {
	if model.EqualOptional(current.AssignedTo, values.AssignedTo) {
		return false, nil
	}
	if current.Status == model.TaskInProgress {
		return false, &model.Fault{Code: "invalid_transition", Message: "Task assignment cannot change while the task is in progress."}
	}
	return true, nil
}

func ActiveWorker(current model.Task, claimID string) (*model.WorkerClaim, error) {
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return nil, err
	}
	if worker == nil || worker.State != model.WorkerActive || worker.ClaimID != claimID || current.Status != model.TaskInProgress {
		return nil, ClaimConflict()
	}
	return worker, nil
}
