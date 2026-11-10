package task

import (
	"context"

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

func (s *TaskSteps) change(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, version int64, changes tasksteps.Changes) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, version)
	if err != nil {
		return result, err
	}
	stepID, err = tasksteps.CanonicalID(stepID)
	if err != nil {
		return result, err
	}
	if err := tasksteps.ValidateChanges(changes); err != nil {
		return result, err
	}
	projectLocked := false
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		projectLocked = true
		if _, err := s.writeOperations.requireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			return err
		}
		header, err := taskWriteHeader(ctx, tx, taskID, version)
		if err != nil {
			return err
		}
		current, err := tx.TaskDAO().TaskSteps(ctx, taskID)
		if err != nil {
			return err
		}
		mutation, err := s.writeOperations.admitChange(header, current, stepID, changes)
		if err != nil {
			return err
		}
		if !mutation.Changed {
			result.Resource, result.JSON, err = taskcodec.EncodeCollection(header, current)
			return err
		}
		observed, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Resource, result.JSON, err = tasksteps.EncodeMutation(header, mutation, observed, "change")
		if err != nil {
			return err
		}
		result.Changed, result.Phase = true, "persist"
		if err := tx.TaskDAO().UpdateTaskStep(ctx, taskID, mutation.Candidate[mutation.To]); err != nil {
			return err
		}
		if err := tx.TaskDAO().TouchTask(ctx, taskID, observed); err != nil {
			return err
		}
		return s.captureStep(ctx, tx, projectID, taskID, stepID, "updated", observed, nil, nil, &current[mutation.To], &mutation.Candidate[mutation.To])
	})
	return finishStepsWrite(result, projectLocked, completion, err)
}
