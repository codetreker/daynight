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

type MoveTaskStep struct {
	Version  int64
	Before   *string
	After    *string
	Position *string
}

func canonicalStepPlacement(input MoveTaskStep) (tasksteps.Placement, error) {
	placement := tasksteps.Placement{Before: input.Before, After: input.After, Position: input.Position}
	count := 0
	for _, value := range []*string{placement.Before, placement.After, placement.Position} {
		if value != nil {
			count++
		}
	}
	if count != 1 {
		return placement, invalidInput("Exactly one of before, after or position must be provided.")
	}
	if placement.Position != nil && *placement.Position != "first" && *placement.Position != "last" {
		return placement, invalidInput("Step position must be first or last.")
	}
	for _, anchor := range []**string{&placement.Before, &placement.After} {
		if *anchor == nil {
			continue
		}
		canonical, err := taskcodec.CanonicalID(**anchor)
		if err != nil {
			return placement, invalidInput(err.Error())
		}
		*anchor = &canonical
	}
	return placement, nil
}

func (s *TaskSteps) Move(ctx context.Context, principal model.Principal, projectID, taskID, stepID string, input MoveTaskStep) (StepsWriteResult, error) {
	result := StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	projectID, taskID, err := taskWriteIdentity(principal, projectID, taskID, input.Version)
	if err != nil {
		return result, err
	}
	stepID, err = taskcodec.CanonicalID(stepID)
	if err != nil {
		return result, invalidInput(err.Error())
	}
	placement, err := canonicalStepPlacement(input)
	if err != nil {
		return result, err
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
		candidate, from, to, err := tasksteps.MoveCandidate(current, stepID, placement)
		switch {
		case errors.Is(err, tasksteps.ErrTargetNotFound):
			return &model.Fault{Code: "not_found", Message: "Step was not found.", Cause: &StepAbsence{Version: header.Version, Cause: err}}
		case errors.Is(err, tasksteps.ErrAnchorNotFound):
			return &model.Fault{Code: "not_found", Message: "Step anchor was not found.", Cause: err}
		case errors.Is(err, tasksteps.ErrSelfAnchor):
			return &model.Fault{Code: "invalid_input", Message: "Step cannot be its own position anchor.", Cause: err}
		case err != nil:
			return err
		}
		if from == to {
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
		header.Version++
		result.Resource, result.JSON, err = taskcodec.EncodeCollection(header, candidate)
		if err != nil {
			return taskStepsEncodingFault(err)
		}
		result.Changed, result.Phase = true, "persist"
		if err := tx.MoveTaskStep(ctx, taskID, stepID, int64(from), int64(to)); err != nil {
			return err
		}
		return tx.TouchTask(ctx, taskID, observed)
	})
	return finishStepsWrite(result, projectLocked, err)
}
