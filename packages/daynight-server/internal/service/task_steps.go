package service

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

type TaskSteps struct{ store *store.Store }

func NewTaskSteps(database *store.Store) *TaskSteps { return &TaskSteps{store: database} }

type StepsDocument struct {
	Resource taskcodec.StepsResource
	JSON     []byte
}

type StepDocument struct {
	Resource taskcodec.StepResource
	JSON     []byte
}

func (s *TaskSteps) read(ctx context.Context, principal model.Principal, projectID, taskID string, operation func(store.TaskReader, model.TaskHeader) error) error {
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
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			return err
		}
		header, err := snapshot.TaskDAO().TaskHeader(ctx, projectID, taskID)
		if errors.Is(err, model.ErrNotFound) {
			return taskNotFound(err)
		}
		if err != nil {
			return err
		}
		if header.DeletedAt != nil {
			return taskNotFound(model.ErrTaskDeleted)
		}
		return operation(snapshot.TaskDAO(), header)
	})
	if err != nil {
		return fmt.Errorf("read task steps: %w", err)
	}
	return nil
}

func (s *TaskSteps) List(ctx context.Context, principal model.Principal, projectID, taskID string) (StepsDocument, error) {
	var document StepsDocument
	err := s.read(ctx, principal, projectID, taskID, func(reader store.TaskReader, header model.TaskHeader) error {
		steps, err := reader.TaskSteps(ctx, header.ID)
		if err != nil {
			return err
		}
		document.Resource, document.JSON, err = taskcodec.EncodeCollection(header, steps)
		return err
	})
	if err != nil {
		return StepsDocument{}, err
	}
	return document, nil
}

func (s *TaskSteps) Get(ctx context.Context, principal model.Principal, projectID, taskID, stepID string) (StepDocument, error) {
	if err := requirePrincipal(principal); err != nil {
		return StepDocument{}, err
	}
	id, err := taskcodec.CanonicalID(stepID)
	if err != nil {
		return StepDocument{}, invalidInput(err.Error())
	}
	var document StepDocument
	err = s.read(ctx, principal, projectID, taskID, func(reader store.TaskReader, header model.TaskHeader) error {
		step, err := reader.TaskStep(ctx, header.ID, id)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: &StepAbsence{Version: header.Version, Cause: err}}
		}
		if err != nil {
			return err
		}
		document.Resource, document.JSON, err = taskcodec.EncodeItem(header, step)
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
func TaskStepsFault(err error) (*model.Fault, bool) {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return nil, false
	}
	fault, pure := taskStepsFault(err)
	return fault, pure && fault != nil
}

func taskStepsFault(err error) (*model.Fault, bool) {
	if failure, ok := err.(*store.TransactionError); ok {
		if failure.Phase != "operation" || failure.CleanupFailed || failure.Outcome != store.TransactionNotCommitted {
			return nil, false
		}
		return taskStepsFault(failure.Cause)
	}
	if err == model.ErrNotFound {
		return nil, true
	}
	if fault, ok := err.(*model.Fault); ok {
		return fault, true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var fault *model.Fault
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
	Status      *model.TaskStepStatus
	Before      *string
	After       *string
}

type StepsWriteResult struct {
	StepsDocument
	Changed            bool
	Phase              string
	TransactionOutcome store.TransactionOutcome
	CleanupFailed      bool
}

func (s *TaskSteps) Add(ctx context.Context, principal model.Principal, projectID, taskID string, input AddTaskStep) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, input.Version)
	if err != nil {
		return result, err
	}
	input.ID, err = taskcodec.CanonicalID(input.ID)
	if err != nil {
		return result, invalidInput(err.Error())
	}
	if err := taskcodec.ValidateText(input.Title, input.Description); err != nil {
		return result, invalidInput(err.Error())
	}
	status := model.TaskStepTodo
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
		canonical, err := taskcodec.CanonicalID(**anchor)
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
		if _, err := taskcodec.Collection(header, current); err != nil {
			return err
		}
		candidate, position, err := tasksteps.AddCandidate(current, model.TaskStep{ID: input.ID, Title: input.Title, Description: input.Description, Status: status}, input.Before, input.After)
		if errors.Is(err, tasksteps.ErrIDConflict) {
			return &model.Fault{Code: "step_id_conflict", Message: "Step ID already exists."}
		}
		if errors.Is(err, tasksteps.ErrAnchorNotFound) {
			return &model.Fault{Code: "not_found", Message: "Step anchor was not found."}
		}
		if err != nil {
			return err
		}
		if header.Version == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
		}
		observed, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		candidate[position].CreatedAt, candidate[position].UpdatedAt = observed, observed
		header.Version++
		result.Resource, result.JSON, err = taskcodec.EncodeCollection(header, candidate)
		if err != nil {
			return taskStepsEncodingFault(err)
		}
		result.Changed = true
		result.Phase = "persist"
		if err := tx.InsertTaskStep(ctx, taskID, candidate[position]); err != nil {
			return err
		}
		return tx.TouchTask(ctx, taskID, observed)
	})
	return finishStepsWrite(result, projectLocked, err)
}

func finishStepsWrite(result StepsWriteResult, projectLocked bool, err error) (StepsWriteResult, error) {
	if err != nil {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) {
			result.TransactionOutcome, result.CleanupFailed = transaction.Outcome, transaction.CleanupFailed
			if transaction.CommitAttempted {
				result.Phase = "commit"
			}
		}
		if !projectLocked && errors.Is(err, model.ErrNotFound) && transaction != nil && transaction.Phase == "operation" && transaction.Outcome == store.TransactionNotCommitted && !transaction.CleanupFailed {
			err = projectNotFound(err)
		}
		result.StepsDocument = StepsDocument{}
		return result, fmt.Errorf("write task steps: %w", err)
	}
	result.Phase, result.TransactionOutcome = "commit", store.TransactionCommitted
	return result, nil
}

func taskStepsEncodingFault(err error) error {
	var limit *taskcodec.LimitError
	if errors.As(err, &limit) {
		return &model.Fault{Code: "steps_limit_exceeded", Message: "Task steps exceed the encoded resource limit.", Cause: err,
			StepsLimit: &model.StepsLimitDetails{EncodedBytes: limit.EncodedBytes, MaxEncodedBytes: taskcodec.MaxEncodedBytes}}
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
