package task

import (
	"context"
	"time"

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

// PrepareParentStart derives a Goal transition from an actual child start while
// the project write lock is held. The caller applies it in the child's transaction.
func PrepareParentStart(ctx context.Context, dao store.TaskWriteDAO, child Mutation) (Mutation, error) {
	if !child.Changed || child.Create || child.Delete || child.Current.Type != model.TaskTypeTask ||
		child.Current.Status == model.TaskInProgress || child.Values.Status != model.TaskInProgress || child.Current.ParentID == nil {
		return Mutation{}, nil
	}
	parent, err := dao.ParentTask(ctx, *child.Current.ParentID)
	if err != nil {
		return Mutation{}, err
	}
	if parent.Type != model.TaskTypeGoal || parent.ParentID != nil {
		return Mutation{}, invalidInput("Parent must identify a visible Goal in this project.")
	}
	if parent.Status != model.TaskTodo {
		return Mutation{}, nil
	}
	values, changed, err := StatusCandidate(ctx, dao, model.Principal{}, parent, SetTaskStatus{Status: model.TaskInProgress}, nil)
	if err != nil {
		return Mutation{}, err
	}
	return Mutation{ID: parent.ID, Current: parent, Values: values, Changed: changed}, nil
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
	if current.Type == model.TaskTypeGoal {
		if input.Status == model.TaskProposed || !input.Status.Valid() {
			return store.TaskWrite{}, false, invalidInput("Goal status must be todo, in_progress, done or cancelled.")
		}
		if input.ClaimID != nil {
			return store.TaskWrite{}, false, invalidInput("Goal does not support worker claims.")
		}
		if current.Status == input.Status {
			return store.TaskWrite{}, false, nil
		}
		now, err := dao.ObservedAt(ctx)
		if err != nil {
			return store.TaskWrite{}, false, err
		}
		values := CurrentWrite(current)
		values.Status = input.Status
		values.GoalTiming = goalTiming(input.Status, current.StartedAt, now)
		return values, true, nil
	}
	if current.Status == input.Status {
		if input.ClaimID != nil {
			if worker == nil || worker.State != model.WorkerCompleted || worker.ClaimID != *input.ClaimID {
				return store.TaskWrite{}, false, ClaimConflict()
			}
			if worker.UserID != principal.UserID {
				return store.TaskWrite{}, false, &model.Fault{Code: "forbidden", Message: "Only the current execution owner may complete worker execution."}
			}
		}
		return store.TaskWrite{}, false, nil
	}
	if current.Status == model.TaskCancelled {
		return store.TaskWrite{}, false, cancelledTransition()
	}
	if input.Status.RequiresSatisfiedPrerequisites() && len(current.BlockedBy) > 0 {
		return store.TaskWrite{}, false, &model.Fault{Code: "dependency_unsatisfied", Message: "Task prerequisites must be done or cancelled.", TaskIDs: current.BlockedBy}
	}
	if current.Status == model.TaskDone && !input.Status.IsTerminal() {
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
			return store.TaskWrite{}, false, PropertyInputError(err)
		}
	} else {
		if input.ClaimID != nil {
			return store.TaskWrite{}, false, ClaimConflict()
		}
	}
	values.Status = input.Status
	return values, true, nil
}

func cancelledTransition() error {
	return &model.Fault{Code: "invalid_transition", Message: "Cancelled tasks cannot resume execution or change status."}
}

func ClaimConflict() error {
	return &model.Fault{Code: "claim_conflict", Message: "Task worker claim does not match the active execution."}
}

func ValidateDelete(ctx context.Context, dao store.TaskWriteDAO, current model.Task, removeDepends bool) error {
	if current.Type == model.TaskTypeGoal {
		if removeDepends {
			return invalidInput("Goal does not support dependency removal.")
		}
		return nil
	}
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

// AssignmentCandidate returns the Task-owned transition. Before applying a
// changed candidate, the caller must verify a non-nil assignee's project access
// in the same project write scope.
func AssignmentCandidate(current model.Task, values store.TaskWrite) (store.TaskWrite, bool, error) {
	if model.EqualOptional(current.AssignedTo, values.AssignedTo) {
		return values, false, nil
	}
	if current.Type != model.TaskTypeGoal && current.Status == model.TaskInProgress {
		return store.TaskWrite{}, false, &model.Fault{Code: "invalid_transition", Message: "Task assignment cannot change while the task is in progress."}
	}
	values.AllowAgents = false
	return values, true, nil
}

func ActiveWorker(current model.Task, claimID string) (*model.WorkerClaim, error) {
	if current.Type == model.TaskTypeGoal {
		return nil, invalidInput("Goal does not support worker execution.")
	}
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		return nil, err
	}
	if worker == nil || worker.State != model.WorkerActive || worker.ClaimID != claimID || current.Status != model.TaskInProgress {
		return nil, ClaimConflict()
	}
	return worker, nil
}

// goalTiming describes the complete current lifecycle round at one authority time.
func goalTiming(status model.TaskStatus, started *time.Time, now time.Time) *store.GoalTiming {
	timing := &store.GoalTiming{ObservedAt: now, StartedAt: started}
	switch status {
	case model.TaskTodo:
		timing.StartedAt = nil
	case model.TaskInProgress:
		timing.StartedAt = &now
	case model.TaskDone:
		timing.CompletedAt = &now
	case model.TaskCancelled:
		timing.CancelledAt = &now
	}
	return timing
}
