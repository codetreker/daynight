package assistanttask

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func inquiryBotBarriers(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, target string) error {
	if task.HolderBotID == nil {
		return lost()
	}
	if target != *task.HolderBotID {
		if err := botOwner(ctx, dao, task.OwnerUserID, target); err != nil {
			return err
		}
	}
	if err := botOwner(ctx, dao, task.OwnerUserID, *task.HolderBotID); err != nil {
		var denial *model.Fault
		if errors.As(err, &denial) && denial.Code == "forbidden" {
			return lost()
		}
		return err
	}
	return nil
}

func (m *Module) Ask(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input InquiryInput) (model.AssistantTaskInquiry, error) {
	var result model.AssistantTaskInquiry
	if actor.BotID == nil {
		return result, forbidden()
	}
	if !strictID(input.ID) || !textValid(input.Question, true) {
		return result, invalid("Inquiry identity and question are required.")
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	if task.State == "paused" {
		return result, fault("task_paused", "The assistant task is paused.")
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if claimView(task, now).State != "active" {
		return result, lost()
	}
	target := *task.HolderBotID
	if input.ItemID != nil {
		if !strictID(*input.ItemID) {
			return result, invalid("Item ID is invalid.")
		}
		item, err := dao.Item(ctx, task.OwnerUserID, task.ID, *input.ItemID)
		if err != nil {
			return result, err
		}
		if item.State == "open" && item.FollowerBotID != nil {
			target = *item.FollowerBotID
		}
	}
	if err = inquiryBotBarriers(ctx, dao, task, target); err != nil {
		return result, err
	}
	hash, err := fingerprint([]any{input.ID, task.ID, actor.BotID, input.ItemID, input.Question})
	if err != nil {
		return result, err
	}
	old, err := dao.Inquiry(ctx, task.OwnerUserID, task.ID, input.ID)
	if err == nil {
		if err = sameRequest(old.RequestFingerprint, hash); err != nil {
			return result, err
		}
		_, err = finish(ctx, dao, actor, nil, target)
		return old, err
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	now, err = dao.Now(ctx)
	if err != nil {
		return result, err
	}
	result = model.AssistantTaskInquiry{ID: input.ID, OwnerUserID: task.OwnerUserID, TaskID: task.ID, ItemID: input.ItemID, FromBotID: *actor.BotID, ToBotID: target, Question: input.Question, State: "open", CreatedAt: now, Deadline: now.Add(LeaseDuration), RequestFingerprint: hash}
	ok, err := dao.InsertInquiry(ctx, result)
	if err != nil {
		return result, err
	}
	if !ok {
		return result, fault("operation_conflict", "Inquiry identity already exists.")
	}
	if _, err = m.systemRecord(ctx, dao, task, "question", input.Question, input.ItemID, map[string]any{"inquiryId": result.ID, "fromBotId": result.FromBotID, "toBotId": target}, now); err != nil {
		return result, err
	}
	if _, err = m.systemEvent(ctx, dao, task, target, "inquiry", map[string]any{"inquiryId": result.ID}, now); err != nil {
		return result, err
	}
	if _, err = saveTask(ctx, dao, task, store.AssistantTaskCondition{Version: task.Version}, now); err != nil {
		return result, err
	}
	if err = inquiryBotBarriers(ctx, dao, task, target); err != nil {
		return result, err
	}
	_, err = finish(ctx, dao, actor, task.LeaseUntil)
	return result, err
}
func (m *Module) Answer(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input AnswerInput) (model.AssistantTaskInquiry, error) {
	var result model.AssistantTaskInquiry
	if !strictID(input.ID) || !textValid(input.Answer, true) {
		return result, invalid("Inquiry identity and answer are required.")
	}
	task, err := m.workingTask(ctx, dao, actor, input.Mutation)
	if err != nil {
		return result, err
	}
	result, err = dao.Inquiry(ctx, task.OwnerUserID, task.ID, input.ID)
	if err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if result.State != "open" || !now.Before(result.Deadline) {
		return result, fault("invalid_transition", "The inquiry is no longer open.")
	}
	result.Answer = input.Answer
	result.AnswerBotID = actor.BotID
	result.State = "answered"
	result.AnsweredAt = &now
	ok, err := dao.SaveInquiry(ctx, result, "open")
	if err != nil {
		return result, err
	}
	if !ok {
		return result, conflict()
	}
	if _, err = m.systemRecord(ctx, dao, task, "answer", input.Answer, result.ItemID, map[string]any{"inquiryId": result.ID, "botId": *actor.BotID}, now); err != nil {
		return result, err
	}
	if _, err = m.systemEvent(ctx, dao, task, result.FromBotID, "answer", map[string]any{"inquiryId": result.ID}, now); err != nil {
		return result, err
	}
	if _, err = saveTask(ctx, dao, task, fence(task, true), now); err != nil {
		return result, err
	}
	finalNow, err := finish(ctx, dao, actor, task.LeaseUntil)
	if err != nil {
		return result, err
	}
	if !finalNow.Before(result.Deadline) {
		return result, fault("invalid_transition", "The inquiry is no longer open.")
	}
	return result, nil
}

func (m *Module) expireInquiries(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID, targetBotID string) error {
	return m.maintain(ctx, dao, actor, taskID, targetBotID, false)
}

// maintain processes a bounded, prefiltered batch of inquiry timeouts and, for
// event pulls, periodic retrospectives. Taking every task barrier once in ID
// order prevents two reads from reversing multi-task lock order.
func (m *Module) maintain(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID, targetBotID string, retrospectives bool) error {
	if err := authorize(ctx, dao, actor); err != nil {
		return err
	}
	if taskID != "" && !strictID(taskID) || targetBotID != "" && !strictID(targetBotID) {
		return invalid("Inquiry scope is invalid.")
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return err
	}
	due, err := dao.Inquiries(ctx, store.AssistantTaskQuery{OwnerUserID: actor.Principal.UserID, TaskID: taskID, State: "open", InquiryBotID: targetBotID, DeadlineBefore: &now, Limit: 200})
	if err != nil {
		return err
	}
	if len(due) > 200 {
		due = due[:200]
	}
	var reviews []string
	if retrospectives {
		reviews, err = dao.RetrospectiveTasks(ctx, store.AssistantTaskQuery{OwnerUserID: actor.Principal.UserID, TaskID: taskID, TargetBotID: targetBotID, Limit: 200}, now.Add(-retrospectivePeriod))
		if err != nil {
			return err
		}
	}
	ids := map[string]bool{}
	for _, inquiry := range due {
		ids[inquiry.TaskID] = true
	}
	for _, id := range reviews {
		ids[id] = true
	}
	ordered := make([]string, 0, len(ids))
	for id := range ids {
		ordered = append(ordered, id)
	}
	sort.Strings(ordered)
	tasks := map[string]model.AssistantTask{}
	for _, id := range ordered {
		task, err := dao.Task(ctx, actor.Principal.UserID, id, true)
		if errors.Is(err, model.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if task.OwnerUserID != actor.Principal.UserID {
			return forbidden()
		}
		if task.State != "deleted" {
			tasks[id] = task
		}
	}
	for _, candidate := range due {
		task, ok := tasks[candidate.TaskID]
		if !ok {
			continue
		}
		inquiry, err := dao.Inquiry(ctx, actor.Principal.UserID, candidate.TaskID, candidate.ID)
		if errors.Is(err, model.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		now, err = dao.Now(ctx)
		if err != nil {
			return err
		}
		if inquiry.State != "open" || now.Before(inquiry.Deadline) {
			continue
		}
		_, task, err = m.expireInquiry(ctx, dao, task, inquiry, now)
		if err != nil {
			return err
		}
		tasks[task.ID] = task
	}
	for _, id := range reviews {
		if task, ok := tasks[id]; ok {
			if err = m.periodicRetrospective(ctx, dao, task); err != nil {
				return err
			}
		}
	}
	_, err = finish(ctx, dao, actor, nil)
	return err
}

// expireInquiry shares the task barrier with answers and preserves the inquiry's
// pagination position while committing its timeout, record and notification.
func (m *Module) expireInquiry(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, inquiry model.AssistantTaskInquiry, now time.Time) (model.AssistantTaskInquiry, model.AssistantTask, error) {
	inquiry.State = "timed_out"
	ok, err := dao.SaveInquiry(ctx, inquiry, "open")
	if err != nil {
		return inquiry, task, err
	}
	if !ok {
		return inquiry, task, conflict()
	}
	if _, err = m.systemRecord(ctx, dao, task, "unknown", "The assistant inquiry reached its deadline without an answer.", inquiry.ItemID, map[string]any{"inquiryId": inquiry.ID}, now); err != nil {
		return inquiry, task, err
	}
	if _, err = m.systemEvent(ctx, dao, task, inquiry.FromBotID, "inquiry_timed_out", map[string]any{"inquiryId": inquiry.ID}, now); err != nil {
		return inquiry, task, err
	}
	task, err = saveTask(ctx, dao, task, store.AssistantTaskCondition{Version: task.Version}, now)
	return inquiry, task, err
}
