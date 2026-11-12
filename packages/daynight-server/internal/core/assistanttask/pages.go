package assistanttask

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type cursor struct {
	Version                                    int `json:"v"`
	Owner, Task, Resource, State, Item, Target string
	Position                                   store.AssistantTaskPosition
}

func pageQuery(actor Actor, taskID, resource string, input PageInput) (store.AssistantTaskQuery, cursor, error) {
	query := store.AssistantTaskQuery{OwnerUserID: actor.Principal.UserID, TaskID: taskID, State: input.State, ItemID: input.ItemID, TargetBotID: input.TargetBotID, Limit: input.Limit}
	if query.Limit == 0 {
		query.Limit = 50
	}
	if query.Limit < 1 || query.Limit > 200 {
		return query, cursor{}, invalid("Page limit must be between 1 and 200.")
	}
	if input.ItemID != "" && !strictID(input.ItemID) || input.TargetBotID != "" && !strictID(input.TargetBotID) {
		return query, cursor{}, invalid("Page filter identities are invalid.")
	}
	var states []string
	switch resource {
	case "tasks":
		states = []string{"active", "paused"}
	case "appendix":
		states = []string{"active", "edited", "deleted"}
	case "proposals":
		states = []string{"pending", "approved", "edited", "rejected"}
	case "items":
		states = []string{"open", "closed"}
	case "inquiries":
		states = []string{"open", "answered", "timed_out"}
	case "events":
		states = []string{"pending", "delivered", "expired"}
	case "manuals", "records":
	default:
		return query, cursor{}, invalid("Page resource is invalid.")
	}
	if input.State != "" && !validState(input.State, states...) {
		return query, cursor{}, invalid("Page state filter is invalid for this resource.")
	}
	if input.ItemID != "" && resource != "records" && resource != "inquiries" || input.TargetBotID != "" && resource != "tasks" && resource != "events" {
		return query, cursor{}, invalid("The resource does not support this page filter.")
	}
	want := cursor{Version: 1, Owner: query.OwnerUserID, Task: taskID, Resource: resource, State: input.State, Item: input.ItemID, Target: input.TargetBotID}
	if input.Cursor != "" {
		encoded, err := base64.RawURLEncoding.DecodeString(input.Cursor)
		if err != nil {
			return query, want, invalid("Page cursor is invalid.")
		}
		var got cursor
		if err = json.Unmarshal(encoded, &got); err != nil {
			return query, want, invalid("Page cursor is invalid.")
		}
		position := got.Position
		got.Position = store.AssistantTaskPosition{}
		if got != want || position.CreatedAt.IsZero() || position.ID == "" {
			return query, want, invalid("Page cursor does not match this query.")
		}
		if resource == "manuals" {
			v, err := strconv.ParseInt(position.ID, 10, 64)
			if err != nil || v < 1 || strconv.FormatInt(v, 10) != position.ID {
				return query, want, invalid("Manual cursor is invalid.")
			}
		} else if !strictID(position.ID) {
			return query, want, invalid("Page cursor identity is invalid.")
		}
		query.After = &position
	}
	return query, want, nil
}
func makePage[T any](items []T, limit int, c cursor, now time.Time, position func(T) store.AssistantTaskPosition) (model.AssistantTaskPage[T], error) {
	result := model.AssistantTaskPage[T]{Items: items, ObservedAt: now}
	if result.Items == nil {
		result.Items = []T{}
	}
	if len(items) > limit {
		result.Items = items[:limit]
		c.Position = position(items[limit-1])
		data, err := json.Marshal(c)
		if err != nil {
			return result, err
		}
		result.NextCursor = ptr(base64.RawURLEncoding.EncodeToString(data))
	}
	return result, nil
}
func readPage[T any](ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID, resource string, input PageInput, read func(context.Context, store.AssistantTaskQuery) ([]T, error), position func(T) store.AssistantTaskPosition) (model.AssistantTaskPage[T], error) {
	var result model.AssistantTaskPage[T]
	if _, err := loadTask(ctx, dao, actor, taskID, false); err != nil {
		return result, err
	}
	query, c, err := pageQuery(actor, taskID, resource, input)
	if err != nil {
		return result, err
	}
	items, err := read(ctx, query)
	if err != nil {
		return result, err
	}
	now, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return result, err
	}
	return makePage(items, query.Limit, c, now, position)
}
func (m *Module) List(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input PageInput) (model.AssistantTaskPage[TaskResult], error) {
	var result model.AssistantTaskPage[TaskResult]
	if input.State != "" && !validState(input.State, "active", "paused") {
		return result, invalid("Task state filter is invalid.")
	}
	if err := authorize(ctx, dao, actor); err != nil {
		return result, err
	}
	query, c, err := pageQuery(actor, "", "tasks", input)
	if err != nil {
		return result, err
	}
	items, err := dao.Tasks(ctx, query)
	if err != nil {
		return result, err
	}
	results := make([]TaskResult, len(items))
	for i, task := range items {
		if task.OwnerUserID != actor.Principal.UserID {
			return result, forbidden()
		}
		results[i] = taskResult(task)
	}
	now, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return result, err
	}
	return makePage(results, query.Limit, c, now, func(v TaskResult) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.Task.CreatedAt, ID: v.Task.ID}
	})
}
func (m *Module) ListManuals(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskManual], error) {
	return readPage(ctx, dao, actor, taskID, "manuals", input, dao.Manuals, func(v model.AssistantTaskManual) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: strconv.FormatInt(v.Version, 10)}
	})
}
func (m *Module) ListAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskAppendix], error) {
	return readPage(ctx, dao, actor, taskID, "appendix", input, dao.Appendices, func(v model.AssistantTaskAppendix) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
}
func (m *Module) ListProposals(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskProposal], error) {
	return readPage(ctx, dao, actor, taskID, "proposals", input, dao.Proposals, func(v model.AssistantTaskProposal) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
}
func (m *Module) ListItems(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskItem], error) {
	return readPage(ctx, dao, actor, taskID, "items", input, dao.Items, func(v model.AssistantTaskItem) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
}
func (m *Module) ListRecords(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskRecord], error) {
	return readPage(ctx, dao, actor, taskID, "records", input, dao.Records, func(v model.AssistantTaskRecord) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
}
func (m *Module) ListInquiries(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskInquiry], error) {
	if _, _, err := pageQuery(actor, taskID, "inquiries", input); err != nil {
		return model.AssistantTaskPage[model.AssistantTaskInquiry]{}, err
	}
	if err := m.expireInquiries(ctx, dao, actor, taskID, ""); err != nil {
		return model.AssistantTaskPage[model.AssistantTaskInquiry]{}, err
	}
	return readPage(ctx, dao, actor, taskID, "inquiries", input, dao.Inquiries, func(v model.AssistantTaskInquiry) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
}
func (m *Module) ListEvents(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string, input PageInput) (model.AssistantTaskPage[model.AssistantTaskEvent], error) {
	var result model.AssistantTaskPage[model.AssistantTaskEvent]
	query, c, err := pageQuery(actor, taskID, "events", input)
	if err != nil {
		return result, err
	}
	if err := m.expireInquiries(ctx, dao, actor, taskID, input.TargetBotID); err != nil {
		return result, err
	}
	if taskID != "" {
		return readPage(ctx, dao, actor, taskID, "events", input, dao.Events, func(v model.AssistantTaskEvent) store.AssistantTaskPosition {
			return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
		})
	}
	if err := authorize(ctx, dao, actor); err != nil {
		return result, err
	}
	items, err := dao.Events(ctx, query)
	if err != nil {
		return result, err
	}
	now, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return result, err
	}
	return makePage(items, query.Limit, c, now, func(v model.AssistantTaskEvent) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
}
