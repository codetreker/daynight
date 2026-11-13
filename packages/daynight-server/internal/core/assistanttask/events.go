package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func eventAttention(kind string) (bool, error) {
	switch kind {
	case "report", "escalation", "result_unknown", "proposal_pending", "inquiry_timed_out", "takeover", "claim_lost":
		return true, nil
	case "update", "resolved", "direct_success", "proposal_decided", "appendix_added", "inquiry", "answer", "transfer", "intervention", "trigger":
		return false, nil
	default:
		return false, invalid("Event type is invalid.")
	}
}
func (m *Module) systemEvent(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, target, kind string, payload any, now time.Time) (model.AssistantTaskEvent, error) {
	return m.systemEventID(ctx, dao, task, uuid.NewString(), target, kind, payload, now)
}
func (m *Module) systemEventID(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, id, target, kind string, payload any, now time.Time) (model.AssistantTaskEvent, error) {
	attention, err := eventAttention(kind)
	if err != nil {
		return model.AssistantTaskEvent{}, err
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return model.AssistantTaskEvent{}, err
	}
	event := model.AssistantTaskEvent{ID: id, OwnerUserID: task.OwnerUserID, TaskID: task.ID, TargetBotID: target, Type: kind, State: "pending", Payload: data, Attention: attention, CreatedAt: now}
	event.RequestFingerprint, err = fingerprint(event)
	if err != nil {
		return event, err
	}
	ok, err := dao.InsertEvent(ctx, event)
	if err != nil {
		return event, err
	}
	if !ok {
		return event, fault("operation_conflict", "Event identity already exists.")
	}
	return event, nil
}
func (m *Module) AddEvent(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input EventInput) (model.AssistantTaskEvent, error) {
	var result model.AssistantTaskEvent
	if !strictID(input.ID) || !strictID(input.TargetBotID) {
		return result, invalid("Event and target Bot identities are required.")
	}
	attention, err := eventAttention(input.Type)
	if err != nil {
		return result, err
	}
	if !validState(input.Type, "report", "update", "resolved", "direct_success", "escalation", "result_unknown", "trigger") {
		return result, forbidden()
	}
	payload, err := canonicalJSON(input.Payload)
	if err != nil {
		return result, err
	}
	task, err := m.workingTask(ctx, dao, actor, input.Mutation)
	if err != nil {
		return result, err
	}
	if task.HolderBotID == nil || input.TargetBotID != *task.HolderBotID {
		return result, forbidden()
	}
	hash, err := fingerprint([]any{input.ID, task.ID, actor.BotID, input.TargetBotID, input.Type, payload})
	if err != nil {
		return result, err
	}
	old, err := dao.Event(ctx, task.OwnerUserID, task.ID, input.ID)
	if err == nil {
		if err = sameRequest(old.RequestFingerprint, hash); err != nil {
			return result, err
		}
		_, err = finish(ctx, dao, actor, task.LeaseUntil)
		return old, err
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	result = model.AssistantTaskEvent{ID: input.ID, OwnerUserID: task.OwnerUserID, TaskID: task.ID, TargetBotID: input.TargetBotID, Type: input.Type, Payload: payload, State: "pending", Attention: attention, RequestFingerprint: hash, CreatedAt: now}
	ok, err := dao.InsertEvent(ctx, result)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fault("operation_conflict", "Event identity already exists.")
	}
	return result, finishWork(ctx, dao, actor, task, now)
}
func (m *Module) AckEvent(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input AckEventInput) (model.AssistantTaskEvent, error) {
	var result model.AssistantTaskEvent
	if actor.BotID == nil {
		return result, forbidden()
	}
	if !strictID(input.ID) || !strictID(input.OperationID) {
		return result, invalid("Event and operation identities are required.")
	}
	if input.State == "" {
		input.State = "delivered"
	}
	if !validState(input.State, "delivered", "expired") {
		return result, invalid("Event acknowledgment state must be delivered or expired.")
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	result, err = dao.Event(ctx, task.OwnerUserID, task.ID, input.ID)
	if err != nil {
		return result, err
	}
	if result.TargetBotID != *actor.BotID {
		return result, forbidden()
	}
	hash, err := fingerprint([]any{input.OperationID, task.ID, input.ID, *actor.BotID, input.State})
	if err != nil {
		return result, err
	}
	if result.AckOperationID != nil {
		if *result.AckOperationID != input.OperationID || result.AckFingerprint == nil || *result.AckFingerprint != hash {
			return result, fault("operation_conflict", "The event was acknowledged by another operation.")
		}
		_, err = finish(ctx, dao, actor, nil)
		return result, err
	}
	if result.State != "pending" {
		return result, fault("invalid_transition", "Only pending events can be acknowledged.")
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	result.State = input.State
	result.DeliveredAt = nil
	if input.State == "delivered" {
		result.DeliveredAt = &now
	}
	result.AckOperationID = ptr(input.OperationID)
	result.AckFingerprint = ptr(hash)
	ok, err := dao.SaveEvent(ctx, result, "pending")
	if err != nil {
		return result, err
	}
	if !ok {
		return result, conflict()
	}
	return result, finishUser(ctx, dao, actor, task, now)
}
func (m *Module) ClearAttention(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, targetBotID string) error {
	if actor.BotID != nil {
		return forbidden()
	}
	if err := authorize(ctx, dao, actor); err != nil {
		return err
	}
	if err := botOwner(ctx, dao, actor.Principal.UserID, targetBotID); err != nil {
		return err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return err
	}
	if err = dao.MarkAttentionSeen(ctx, actor.Principal.UserID, targetBotID, now, []string{"proposal_pending"}); err != nil {
		return err
	}
	_, err = finish(ctx, dao, actor, nil, targetBotID)
	return err
}
