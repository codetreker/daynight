package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func (m *Module) SaveItem(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input ItemInput) (model.AssistantTaskItem, error) {
	actor = actor.requiringBranches("SaveItem", "default")
	var result model.AssistantTaskItem
	if !strictID(input.ID) || !keyValid(input.Key) || !validState(input.State, "open", "closed") || !textValid(input.Category, false) || input.Episode < 1 {
		return result, invalid("Item identity, key, episode or state is invalid.")
	}
	appState, err := canonicalJSON(input.AppState)
	if err != nil {
		return result, err
	}
	task, err := m.workingTask(ctx, dao, actor, input.Mutation)
	if err != nil {
		return result, err
	}
	hash, err := fingerprint([]any{input.ID, task.ID, input.Key, input.Episode, input.State, input.Category, appState, actor.BotID})
	if err != nil {
		return result, err
	}
	old, err := dao.Item(ctx, task.OwnerUserID, task.ID, input.ID)
	exists := err == nil
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if exists {
		if input.ItemVersion == nil {
			if err = sameRequest(old.RequestFingerprint, hash); err != nil {
				return result, err
			}
			_, err = finish(ctx, dao, actor, task.LeaseUntil)
			return old, err
		}
		if *input.ItemVersion != old.Version {
			return result, conflict()
		}
		if input.Key != old.Key || input.Episode != old.Episode {
			return result, invalid("Item key and episode are immutable.")
		}
		result = old
		result.Version, err = advance(old.Version)
		if err != nil {
			return result, err
		}
		result.State = input.State
		result.Category = input.Category
		result.AppState = appState
		result.FollowerBotID = task.HolderBotID
		result.UpdatedAt = now
		closing := old.State == "open" && result.State == "closed"
		switch {
		case old.State == "closed" && result.State == "open":
			result.OpenedAt = &now
		case closing:
			result.ClosedAt = &now
		}
		ok, err := dao.SaveItem(ctx, result, old.Version)
		if err != nil {
			return result, err
		}
		if !ok {
			return result, conflict()
		}
		if closing {
			// The task lock serializes item writes, so the closed period's
			// opening time is the one read with the previous state.
			closure := model.AssistantTaskItemClosure{ID: uuid.NewString(), OwnerUserID: task.OwnerUserID, TaskID: task.ID, ItemID: result.ID, Episode: result.Episode, OpenedAt: old.OpenedAt, ClosedAt: now}
			if err = dao.InsertItemClosure(ctx, closure); err != nil {
				return result, err
			}
			// Item writes require the live holder of an active task, so the
			// retrospective always targets that holder and never a paused task.
			// The episode is a decimal string like the item API's, because
			// int64 values exceed the range that JavaScript consumers parse.
			if _, err = m.systemEvent(ctx, dao, task, *task.HolderBotID, "retrospective", map[string]any{"reason": "item_closed", "itemId": result.ID, "episode": strconv.FormatInt(result.Episode, 10)}, now); err != nil {
				return result, err
			}
		}
	} else {
		if input.ItemVersion != nil {
			return result, model.ErrNotFound
		}
		result = model.AssistantTaskItem{ID: input.ID, OwnerUserID: task.OwnerUserID, TaskID: task.ID, Key: input.Key, Episode: input.Episode, State: input.State, Category: input.Category, AppState: appState, FollowerBotID: task.HolderBotID, Version: 1, RequestFingerprint: hash, CreatedAt: now, UpdatedAt: now}
		if result.State == "open" {
			result.OpenedAt = &now
		}
		ok, err := dao.InsertItem(ctx, result)
		if err != nil {
			return result, err
		}
		if !ok {
			return result, fault("operation_conflict", "Item identity already exists.")
		}
	}
	return result, finishWork(ctx, dao, actor, task, now)
}

func insertRecord(ctx context.Context, dao store.AssistantTaskDAO, record model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
	result, err := dao.InsertRecord(ctx, record)
	var clockErr *store.ThreadClockError
	if errors.As(err, &clockErr) {
		return result, &model.Fault{Code: "clock_not_advanced", Message: "A reliable record timestamp could not be obtained.", Cause: err}
	}
	return result, err
}
func (m *Module) systemRecord(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, kind, text string, itemID *string, refs any, now time.Time) (model.AssistantTaskRecord, error) {
	data, err := json.Marshal(refs)
	if err != nil {
		return model.AssistantTaskRecord{}, err
	}
	record := model.AssistantTaskRecord{ID: uuid.NewString(), OwnerUserID: task.OwnerUserID, TaskID: task.ID, ItemID: itemID, Author: "system", Kind: kind, Text: text, Refs: data, CreatedAt: now}
	record.RequestFingerprint, err = fingerprint(record)
	if err != nil {
		return record, err
	}
	return insertRecord(ctx, dao, record)
}
func (m *Module) AddRecord(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input RecordInput) (model.AssistantTaskRecord, error) {
	actor = actor.requiringBranches("AddRecord", "default")
	var result model.AssistantTaskRecord
	if actor.BotID == nil {
		return result, forbidden()
	}
	if !strictID(input.ID) || !textValid(input.Text, true) || !validState(input.Kind, "fact", "guess", "action", "unknown", "question", "answer", "note", "outcome") {
		return result, invalid("Record identity, text or kind is invalid.")
	}
	if input.Kind == "outcome" {
		if input.Outcome == nil || !validState(*input.Outcome, "effective", "ineffective", "inconclusive") || input.ActionRecordID == nil || !strictID(*input.ActionRecordID) {
			return result, invalid("Outcome records require an outcome value and an action record ID.")
		}
	} else if input.Outcome != nil || input.ActionRecordID != nil {
		return result, invalid("Only outcome records carry an outcome value or action record ID.")
	}
	refs, err := canonicalJSON(input.Refs)
	if err != nil {
		return result, err
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if task.State == "paused" {
		return result, fault("task_paused", "The assistant task is paused.")
	}
	holder := task.HolderBotID != nil && *task.HolderBotID == *actor.BotID
	if holder || input.ClaimToken != "" || input.ClaimGeneration != 0 {
		if err = protected(task, actor, input.ClaimGeneration, input.ClaimToken, now, false); err != nil {
			return result, err
		}
	} else if !validState(input.Kind, "action", "note") {
		return result, forbidden()
	}
	if input.ItemID != nil {
		if !strictID(*input.ItemID) {
			return result, invalid("Item ID is invalid.")
		}
		if _, err = dao.Item(ctx, task.OwnerUserID, task.ID, *input.ItemID); err != nil {
			return result, err
		}
	}
	if input.Kind == "outcome" {
		action, err := dao.Record(ctx, task.OwnerUserID, task.ID, *input.ActionRecordID)
		if errors.Is(err, model.ErrNotFound) || err == nil && action.Kind != "action" {
			return result, invalid("The action record ID must refer to an action record of this task.")
		}
		if err != nil {
			return result, err
		}
	}
	request := []any{input.ID, task.ID, actor.BotID, input.ItemID, input.Kind, input.Text, refs}
	// Appending only for outcomes keeps fingerprints of records stored before
	// the outcome kind existed valid for their replays.
	if input.Kind == "outcome" {
		request = append(request, *input.Outcome, *input.ActionRecordID)
	}
	hash, err := fingerprint(request)
	if err != nil {
		return result, err
	}
	old, err := dao.Record(ctx, task.OwnerUserID, task.ID, input.ID)
	if err == nil {
		if err = sameRequest(old.RequestFingerprint, hash); err != nil {
			return result, err
		}
		var until *time.Time
		if holder {
			until = task.LeaseUntil
		}
		_, err = finish(ctx, dao, actor, until)
		return old, err
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	result = model.AssistantTaskRecord{ID: input.ID, OwnerUserID: task.OwnerUserID, TaskID: task.ID, ItemID: input.ItemID, Author: "bot", AuthorBotID: actor.BotID, Kind: input.Kind, Text: input.Text, Outcome: input.Outcome, ActionRecordID: input.ActionRecordID, Refs: refs, RequestFingerprint: hash, CreatedAt: now}
	result, err = insertRecord(ctx, dao, result)
	if err != nil {
		return result, err
	}
	if holder {
		return result, finishWork(ctx, dao, actor, task, now)
	}
	if task.HolderBotID != nil && !task.HolderDeleted {
		if _, err = m.systemEvent(ctx, dao, task, *task.HolderBotID, "intervention", map[string]any{"recordId": result.ID, "botId": *actor.BotID}, now); err != nil {
			return result, err
		}
	}
	return result, finishUser(ctx, dao, actor, task, now)
}
