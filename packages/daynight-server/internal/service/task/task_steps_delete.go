package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
)

type DeleteTaskStep struct{ Version int64 }

func (s *TaskSteps) Delete(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, input DeleteTaskStep) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, input.Version)
	if err != nil {
		return result, err
	}
	stepID, err = tasksteps.CanonicalID(stepID)
	if err != nil {
		return result, err
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
		mutation, err := tasksteps.AdmitDelete(header, current, stepID)
		if err != nil {
			return err
		}
		observed, err := tx.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Resource, result.JSON, err = tasksteps.EncodeMutation(header, mutation, observed, "")
		if err != nil {
			return err
		}
		result.Changed, result.Phase = true, "persist"
		if err := tx.TaskDAO().DeleteTaskStep(ctx, taskID, stepID, int64(mutation.From), int64(len(current)-mutation.From-1)); err != nil {
			return err
		}
		return tx.TaskDAO().TouchTask(ctx, taskID, observed)
	})
	return finishStepsWrite(result, projectLocked, completion, err)
}
