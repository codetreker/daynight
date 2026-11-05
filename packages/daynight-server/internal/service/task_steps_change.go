package service

import (
	"context"
	"errors"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

type UpdateTaskStep struct {
	Version     int64
	Title       *string
	Description *string
}

type SetTaskStepStatus struct {
	Version int64
	Status  model.TaskStepStatus
}

func (s *TaskSteps) Update(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, input UpdateTaskStep) (StepsWriteResult, error) {
	return s.change(ctx, principal, projectID, taskID, stepID, input.Version, tasksteps.Changes{Title: input.Title, Description: input.Description})
}

func (s *TaskSteps) SetStatus(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, input SetTaskStepStatus) (StepsWriteResult, error) {
	return s.change(ctx, principal, projectID, taskID, stepID, input.Version, tasksteps.Changes{Status: &input.Status})
}

func validateStepChanges(changes tasksteps.Changes) error {
	if changes.Title == nil && changes.Description == nil && changes.Status == nil {
		return invalidInput("At least one step field must be provided.")
	}
	if changes.Title != nil {
		if err := taskcodec.ValidateTitle(*changes.Title); err != nil {
			return invalidInput(err.Error())
		}
	}
	if changes.Description != nil {
		if err := taskcodec.ValidateDescription(*changes.Description); err != nil {
			return invalidInput(err.Error())
		}
	}
	if changes.Status != nil && !changes.Status.Valid() {
		return invalidInput("Step status must be todo, in_progress, done or skipped.")
	}
	return nil
}

func (s *TaskSteps) change(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, version int64, changes tasksteps.Changes) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, version)
	if err != nil {
		return result, err
	}
	stepID, err = taskcodec.CanonicalID(stepID)
	if err != nil {
		return result, invalidInput(err.Error())
	}
	if err := validateStepChanges(changes); err != nil {
		return result, err
	}
	projectLocked := false
	err = s.store.WriteProject(ctx, projectID, func(tx *store.ProjectTx) error {
		projectLocked = true
		if _, err := RequireProjectWrite(ctx, tx, principal); err != nil {
			return err
		}
		header, err := taskWriteHeader(ctx, tx, taskID, version)
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
		candidate, index, changed, err := tasksteps.ChangeCandidate(current, stepID, changes)
		if errors.Is(err, tasksteps.ErrTargetNotFound) {
			return &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: &StepAbsence{Version: header.Version, Cause: err}}
		}
		if err != nil {
			return err
		}
		if !changed {
			result.Resource, result.JSON, err = taskcodec.EncodeCollection(header, current)
			return err
		}
		if header.Version == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
		}
		observed, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		candidate[index].UpdatedAt = observed
		header.Version++
		result.Resource, result.JSON, err = taskcodec.EncodeCollection(header, candidate)
		if err != nil {
			return taskStepsEncodingFault(err)
		}
		result.Changed, result.Phase = true, "persist"
		if err := tx.UpdateTaskStep(ctx, taskID, candidate[index]); err != nil {
			return err
		}
		return tx.TouchTask(ctx, taskID, observed)
	})
	return finishStepsWrite(result, projectLocked, err)
}
