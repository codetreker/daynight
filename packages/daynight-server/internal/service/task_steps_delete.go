package service

import (
	"context"
	"errors"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

type DeleteTaskStep struct{ Version int64 }

func (s *TaskSteps) Delete(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, input DeleteTaskStep) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, input.Version)
	if err != nil {
		return result, err
	}
	stepID, err = taskcodec.CanonicalID(stepID)
	if err != nil {
		return result, invalidInput(err.Error())
	}
	projectLocked := false
	completion, err := s.store.WriteProject(ctx, projectID, func(tx store.ProjectWriteScope) error {
		projectLocked = true
		if _, err := projectcore.RequireProjectWrite(ctx, tx.ProjectDAO(), principal); err != nil {
			return err
		}
		header, err := taskWriteHeader(ctx, tx, taskID, input.Version)
		if err != nil {
			return err
		}
		current, err := tx.TaskDAO().TaskSteps(ctx, taskID)
		if err != nil {
			return err
		}
		if _, err := taskcodec.Collection(header, current); err != nil {
			return err
		}
		candidate, index, err := tasksteps.DeleteCandidate(current, stepID)
		if errors.Is(err, tasksteps.ErrTargetNotFound) {
			return &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: &StepAbsence{Version: header.Version, Cause: err}}
		}
		if err != nil {
			return err
		}
		if header.Version == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "Task version is exhausted."}
		}
		observed, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		header.Version++
		result.Resource, result.JSON, err = taskcodec.EncodeCollection(header, candidate)
		if err != nil {
			return taskStepsEncodingFault(err)
		}
		result.Changed, result.Phase = true, "persist"
		if err := tx.TaskDAO().DeleteTaskStep(ctx, taskID, stepID, int64(index), int64(len(current)-index-1)); err != nil {
			return err
		}
		return tx.TaskDAO().TouchTask(ctx, taskID, observed)
	})
	return finishStepsWrite(result, projectLocked, completion, err)
}
