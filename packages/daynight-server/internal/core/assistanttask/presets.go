package assistanttask

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// EnablePreset creates or selects the owner's application singleton and assigns
// its chosen Bot in the same transaction. The application supplies its manual.
func (m *Module) EnablePreset(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input CreateInput, target string) (TaskResult, error) {
	var zero TaskResult
	if actor.BotID != nil {
		return zero, forbidden()
	}
	if !strictID(input.ID) || !strictID(target) || input.Application == "" {
		return zero, invalid("Preset identity, application and target Bot are required.")
	}
	if err := authorize(ctx, dao, actor); err != nil {
		return zero, err
	}
	if err := botOwner(ctx, dao, actor.Principal.UserID, target); err != nil {
		return zero, err
	}
	task, err := dao.ApplicationTask(ctx, actor.Principal.UserID, input.Application)
	if errors.Is(err, model.ErrNotFound) {
		created, createErr := m.Create(ctx, dao, actor, input)
		if createErr == nil {
			task = created.Task
			err = nil
		} else {
			// The unique application index arbitrates concurrent creates, including
			// callers of ordinary creation. A fresh statement sees the winner.
			var fault *model.Fault
			if !errors.As(createErr, &fault) || fault.Code != "operation_conflict" {
				return zero, createErr
			}
			task, err = dao.ApplicationTask(ctx, actor.Principal.UserID, input.Application)
			if errors.Is(err, model.ErrNotFound) {
				return zero, createErr
			}
		}
	}
	if err != nil {
		return zero, err
	}
	task, err = loadTask(ctx, dao, actor, task.ID, true)
	if err != nil {
		return zero, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return zero, err
	}
	previous := task
	claim := claimView(task, now)
	assign := task.HolderBotID == nil || *task.HolderBotID != target || claim.State == "expired"
	task.State = "active"
	if assign {
		task.ClaimGeneration, err = advance(task.ClaimGeneration)
		if err != nil {
			return zero, err
		}
		task.HolderBotID = ptr(target)
		task.ClaimTokenHash = nil
		task.CredentialOperationID = nil
		task.ClaimedAt = ptr(now)
		task.RenewedAt = nil
		task.LeaseUntil = ptr(now.Add(LeaseDuration))
		task.HolderDeleted = false
	}
	if assign || previous.State != task.State {
		task, err = saveTask(ctx, dao, task, store.AssistantTaskCondition{Version: previous.Version}, now)
		if err != nil {
			return zero, err
		}
	}
	if assign {
		if err = dao.TransferOpenItems(ctx, task.OwnerUserID, task.ID, task.HolderBotID); err != nil {
			return zero, err
		}
		if _, err = m.systemEvent(ctx, dao, task, target, "transfer", map[string]any{"generation": task.ClaimGeneration, "previousLeaseUntil": previous.LeaseUntil}, now); err != nil {
			return zero, err
		}
		if previous.HolderBotID != nil && *previous.HolderBotID != target && !previous.HolderDeleted {
			if _, err = m.systemEvent(ctx, dao, task, *previous.HolderBotID, "claim_lost", map[string]any{"reason": "transfer", "holderBotId": target}, now); err != nil {
				return zero, err
			}
		}
	}
	observed, err := finish(ctx, dao, actor, nil, target)
	if err != nil {
		return zero, err
	}
	task.ObservedAt = observed
	return taskResult(task), nil
}
