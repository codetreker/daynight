package assistanttask

import (
	"context"
	"errors"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (m *Module) Create(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input CreateInput) (TaskResult, error) {
	var result TaskResult
	if actor.BotID != nil {
		return result, forbidden()
	}
	if !strictID(input.ID) || !textValid(input.Name, true) || !textValid(input.Purpose, false) || !textValid(input.Scope, false) || !textValid(input.Body, true) || !textValid(input.Application, false) {
		return result, invalid("Assistant task identity, name and manual are required.")
	}
	if input.Kind != "continuous" && input.Kind != "once" {
		return result, invalid("Task kind must be continuous or once.")
	}
	if input.Takeover != "manual" && input.Takeover != "auto" {
		return result, invalid("Takeover must be manual or auto.")
	}
	rules, _, err := m.rules(input.Application, nil, input.Rules)
	if err != nil {
		return result, err
	}
	input.Rules = rules
	input.Trigger, err = normalizeTrigger(input.Trigger)
	if err != nil {
		return result, err
	}
	requestHash, err := fingerprint(input)
	if err != nil {
		return result, err
	}
	if err = authorize(ctx, dao, actor); err != nil {
		return result, err
	}
	if err = dao.LockCreation(ctx, input.ID); err != nil {
		return result, err
	}
	current, err := dao.Task(ctx, actor.Principal.UserID, input.ID, true)
	if err == nil {
		if current.OwnerUserID != actor.Principal.UserID {
			return result, forbidden()
		}
		if current.State == "deleted" {
			return result, fault("task_deleted", "The assistant task was deleted.")
		}
		if err = sameRequest(current.RequestFingerprint, requestHash); err != nil {
			return result, err
		}
		if _, err = finish(ctx, dao, actor, nil); err != nil {
			return result, err
		}
		return taskResult(current), nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	task := model.AssistantTask{ID: input.ID, OwnerUserID: actor.Principal.UserID, Application: input.Application, Name: input.Name, Purpose: input.Purpose, Scope: input.Scope, Kind: input.Kind, State: "active", Takeover: input.Takeover, Trigger: input.Trigger, RequestFingerprint: requestHash, Version: 1, ManualVersion: 1, CreatedAt: now, UpdatedAt: now, ObservedAt: now}
	ok, err := dao.InsertTask(ctx, task)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fault("operation_conflict", "The assistant task ID or application already exists.")
	}
	manual := model.AssistantTaskManual{OwnerUserID: task.OwnerUserID, TaskID: task.ID, Version: 1, Body: input.Body, Rules: rules, Source: "initial", CreatedAt: now}
	if err = dao.InsertManual(ctx, manual); err != nil {
		return result, err
	}
	observed, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return result, err
	}
	task.ObservedAt = observed
	return taskResult(task), nil
}

func (m *Module) Get(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string) (TaskResult, error) {
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return TaskResult{}, err
	}
	if _, err = finish(ctx, dao, actor, nil); err != nil {
		return TaskResult{}, err
	}
	return taskResult(task), nil
}

func (m *Module) Update(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input UpdateInput) (TaskResult, error) {
	var result TaskResult
	if actor.BotID != nil {
		return result, forbidden()
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	if err = expectedVersion(task, input.IfVersion); err != nil {
		return result, err
	}
	before := task
	for _, field := range []struct {
		value    *string
		target   *string
		required bool
	}{{input.Name, &task.Name, true}, {input.Purpose, &task.Purpose, false}, {input.Scope, &task.Scope, false}} {
		if field.value != nil {
			if !textValid(*field.value, field.required) {
				return result, invalid("Task text is invalid.")
			}
			*field.target = *field.value
		}
	}
	if input.Takeover != nil {
		if *input.Takeover != "manual" && *input.Takeover != "auto" {
			return result, invalid("Takeover must be manual or auto.")
		}
		task.Takeover = *input.Takeover
	}
	if input.State != nil {
		if *input.State != "active" && *input.State != "paused" && *input.State != "deleted" {
			return result, invalid("Task state is invalid.")
		}
		task.State = *input.State
	}
	if input.Trigger != nil {
		task.Trigger, err = normalizeTrigger(*input.Trigger)
		if err != nil {
			return result, err
		}
	}
	if input.Name == nil && input.Purpose == nil && input.Scope == nil && input.Takeover == nil && input.State == nil && input.Trigger == nil {
		return result, invalid("At least one task change is required.")
	}
	if task.Name == before.Name && task.Purpose == before.Purpose && task.Scope == before.Scope && task.Takeover == before.Takeover && task.State == before.State && string(task.Trigger) == string(before.Trigger) {
		if _, err = finish(ctx, dao, actor, nil); err != nil {
			return result, err
		}
		return taskResult(task), nil
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if task.State == "deleted" {
		task.Name = ""
		task.Purpose = ""
		task.Scope = ""
		task.Trigger = nil
		task.HolderBotID = nil
		task.ClaimTokenHash = nil
		task.CredentialOperationID = nil
		task.ClaimedAt = nil
		task.RenewedAt = nil
		task.LeaseUntil = nil
		task.HolderDeleted = false
		task.ManualVersion = 0
		task.ClaimGeneration, err = advance(task.ClaimGeneration)
		if err != nil {
			return result, err
		}
		if err = dao.DeleteTaskContent(ctx, task.OwnerUserID, task.ID); err != nil {
			return result, err
		}
	}
	task, err = saveTask(ctx, dao, task, store.AssistantTaskCondition{Version: before.Version}, now)
	if err != nil {
		return result, err
	}
	if _, err = finish(ctx, dao, actor, nil); err != nil {
		return result, err
	}
	// A user mutation does not hold the holder's deletion barrier. Return a new
	// database projection instead of attaching a later time to the old holder.
	task, err = dao.Task(ctx, actor.Principal.UserID, task.ID, false)
	if err != nil {
		return result, err
	}
	if task.OwnerUserID != actor.Principal.UserID {
		return result, forbidden()
	}
	return taskResult(task), nil
}

func (m *Module) GetManual(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, version int64) (model.AssistantTaskManual, error) {
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return model.AssistantTaskManual{}, err
	}
	if version == 0 {
		version = task.ManualVersion
	}
	if version < 1 {
		return model.AssistantTaskManual{}, invalid("Manual version must be positive.")
	}
	manual, err := dao.Manual(ctx, task.OwnerUserID, task.ID, version)
	if err != nil {
		return manual, err
	}
	_, err = finish(ctx, dao, actor, nil)
	return manual, err
}

func (m *Module) GetItem(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID, id string) (model.AssistantTaskItem, error) {
	if !strictID(id) {
		return model.AssistantTaskItem{}, invalid("Item ID must be a canonical UUID.")
	}
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return model.AssistantTaskItem{}, err
	}
	item, err := dao.Item(ctx, task.OwnerUserID, task.ID, id)
	if err != nil {
		return item, err
	}
	_, err = finish(ctx, dao, actor, nil)
	return item, err
}

func (m *Module) workingTask(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input Mutation) (model.AssistantTask, error) {
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return task, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return task, err
	}
	err = protected(task, actor, input.ClaimGeneration, input.ClaimToken, now, false)
	return task, err
}

func validState(value string, allowed ...string) bool {
	for _, state := range allowed {
		if value == state {
			return true
		}
	}
	return false
}
func keyValid(key string) bool { return textValid(key, true) && strings.TrimSpace(key) == key }
