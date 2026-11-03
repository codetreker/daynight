package service

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
)

type TaskSteps struct{ store *store.Store }

func NewTaskSteps(database *store.Store) *TaskSteps { return &TaskSteps{store: database} }

type StepsDocument struct {
	Resource tasksteps.StepsResource
	JSON     []byte
}

type StepDocument struct {
	Resource tasksteps.StepResource
	JSON     []byte
}

func (s *TaskSteps) read(ctx context.Context, principal core.Principal, projectID, taskID string, operation func(*store.Snapshot, core.TaskHeader) error) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return err
	}
	taskID, err = CanonicalID(taskID)
	if err != nil {
		return err
	}
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := RequireProjectRead(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		header, err := snapshot.TaskHeader(ctx, projectID, taskID)
		if errors.Is(err, core.ErrNotFound) {
			return taskNotFound(err)
		}
		if err != nil {
			return err
		}
		if header.DeletedAt != nil {
			return taskNotFound(core.ErrTaskDeleted)
		}
		return operation(snapshot, header)
	})
	if err != nil {
		return fmt.Errorf("read task steps: %w", err)
	}
	return nil
}

func (s *TaskSteps) List(ctx context.Context, principal core.Principal, projectID, taskID string) (StepsDocument, error) {
	var document StepsDocument
	err := s.read(ctx, principal, projectID, taskID, func(snapshot *store.Snapshot, header core.TaskHeader) error {
		steps, err := snapshot.TaskSteps(ctx, header.ID)
		if err != nil {
			return err
		}
		document.Resource, document.JSON, err = tasksteps.EncodeCollection(header, steps)
		return err
	})
	if err != nil {
		return StepsDocument{}, err
	}
	return document, nil
}

func (s *TaskSteps) Get(ctx context.Context, principal core.Principal, projectID, taskID, stepID string) (StepDocument, error) {
	if err := requirePrincipal(principal); err != nil {
		return StepDocument{}, err
	}
	id, err := tasksteps.CanonicalID(stepID)
	if err != nil {
		return StepDocument{}, invalidInput(err.Error())
	}
	var document StepDocument
	err = s.read(ctx, principal, projectID, taskID, func(snapshot *store.Snapshot, header core.TaskHeader) error {
		step, err := snapshot.TaskStep(ctx, header.ID, id)
		if errors.Is(err, core.ErrNotFound) {
			return &Fault{Code: "not_found", Message: "Step was not found.", Cause: &StepAbsence{Version: header.Version, Cause: err}}
		}
		if err != nil {
			return err
		}
		document.Resource, document.JSON, err = tasksteps.EncodeItem(header, step)
		return err
	})
	if err != nil {
		return StepDocument{}, err
	}
	return document, nil
}

// The store may join its exact not-found marker around a wrapped business
// refusal. Other joined branches can represent failed transaction cleanup and
// must keep the whole operation an internal failure.
func TaskStepsFault(err error) (*Fault, bool) {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return nil, false
	}
	fault, pure := taskStepsFault(err)
	return fault, pure && fault != nil
}

func taskStepsFault(err error) (*Fault, bool) {
	if failure, ok := err.(*store.TransactionError); ok {
		if failure.Phase != "operation" || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted {
			return nil, false
		}
		return taskStepsFault(failure.Cause)
	}
	if err == core.ErrNotFound {
		return nil, true
	}
	if fault, ok := err.(*Fault); ok {
		return fault, true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var fault *Fault
		for _, child := range joined.Unwrap() {
			candidate, pure := taskStepsFault(child)
			if !pure {
				return nil, false
			}
			if candidate != nil {
				fault = candidate
			}
		}
		return fault, true
	}
	if cause := errors.Unwrap(err); cause != nil {
		return taskStepsFault(cause)
	}
	return nil, false
}

type AddTaskStep struct {
	Version     int64
	ID          string
	Title       string
	Description string
	Status      *core.TaskStepStatus
	Before      *string
	After       *string
}

type StepsWriteResult struct {
	StepsDocument
	Phase              string
	TransactionOutcome store.TransactionOutcome
	CleanupFailed      bool
}

func (s *TaskSteps) Add(ctx context.Context, principal core.Principal, projectID, taskID string, input AddTaskStep) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, input.Version)
	if err != nil {
		return result, err
	}
	input.ID, err = tasksteps.CanonicalID(input.ID)
	if err != nil {
		return result, invalidInput(err.Error())
	}
	if err := tasksteps.ValidateText(input.Title, input.Description); err != nil {
		return result, invalidInput(err.Error())
	}
	status := core.TaskStepTodo
	if input.Status != nil {
		status = *input.Status
	}
	if !status.Valid() {
		return result, invalidInput("Step status must be todo, in_progress, done or skipped.")
	}
	if input.Before != nil && input.After != nil {
		return result, invalidInput("before and after are mutually exclusive.")
	}
	for _, anchor := range []**string{&input.Before, &input.After} {
		if *anchor == nil {
			continue
		}
		canonical, err := tasksteps.CanonicalID(**anchor)
		if err != nil {
			return result, invalidInput(err.Error())
		}
		*anchor = &canonical
	}
	projectLocked := false
	err = s.store.WriteProject(ctx, projectID, func(tx *store.ProjectTx) error {
		projectLocked = true
		if _, err := RequireProjectWrite(ctx, tx, principal); err != nil {
			return err
		}
		header, err := taskWriteHeader(ctx, tx, taskID, input.Version)
		if err != nil {
			return err
		}
		current, err := tx.TaskSteps(ctx, taskID)
		if err != nil {
			return err
		}
		if _, err := tasksteps.Collection(header, current); err != nil {
			return err
		}
		candidate, position, err := tasksteps.AddCandidate(current, core.TaskStep{ID: input.ID, Title: input.Title, Description: input.Description, Status: status}, input.Before, input.After)
		if errors.Is(err, tasksteps.ErrIDConflict) {
			return &Fault{Code: "step_id_conflict", Message: "Step ID already exists."}
		}
		if errors.Is(err, tasksteps.ErrAnchorNotFound) {
			return &Fault{Code: "not_found", Message: "Step anchor was not found."}
		}
		if err != nil {
			return err
		}
		if header.Version == math.MaxInt64 {
			return &Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
		}
		observed, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		candidate[position].CreatedAt, candidate[position].UpdatedAt = observed, observed
		header.Version++
		result.Resource, result.JSON, err = tasksteps.EncodeCollection(header, candidate)
		if err != nil {
			return taskStepsEncodingFault(err)
		}
		result.Phase = "persist"
		if err := tx.InsertTaskStep(ctx, taskID, candidate[position]); err != nil {
			return err
		}
		return tx.TouchTask(ctx, taskID, observed)
	})
	if err != nil {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) {
			result.TransactionOutcome, result.CleanupFailed = transaction.Outcome, transaction.CleanupFailed
			if transaction.CommitAttempted {
				result.Phase = "commit"
			}
		}
		if !projectLocked && errors.Is(err, core.ErrNotFound) && transaction != nil && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed {
			err = projectNotFound(err)
		}
		result.StepsDocument = StepsDocument{}
		return result, fmt.Errorf("add task step: %w", err)
	}
	result.Phase, result.TransactionOutcome = "commit", store.TransactionCommitted
	return result, nil
}

func taskStepsEncodingFault(err error) error {
	var limit *tasksteps.LimitError
	if errors.As(err, &limit) {
		return &Fault{Code: "steps_limit_exceeded", Message: "Task steps exceed the encoded resource limit.", Cause: err,
			StepsLimit: &StepsLimitDetails{EncodedBytes: limit.EncodedBytes, MaxEncodedBytes: tasksteps.MaxEncodedBytes}}
	}
	return err
}

// StepAbsence records only a child absence established after parent admission.
type StepAbsence struct {
	Version int64
	Cause   error
}

func (err *StepAbsence) Error() string { return "step is currently absent" }
func (err *StepAbsence) Unwrap() error { return err.Cause }
