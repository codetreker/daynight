package service

import (
	"context"
	"errors"
	"fmt"

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
			return &Fault{Code: "not_found", Message: "Step was not found.", Cause: err}
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
	fault, pure := taskStepsFault(err)
	return fault, pure && fault != nil
}

func taskStepsFault(err error) (*Fault, bool) {
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
