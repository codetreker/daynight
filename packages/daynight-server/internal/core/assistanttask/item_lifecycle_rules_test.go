package assistanttask

import (
	"context"
	"errors"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestItemWritesTrackOpenPeriodsAndRecordClosures(t *testing.T) {
	earlier, previous := epoch.Add(-time.Hour), epoch.Add(-2*time.Hour)
	cases := []struct {
		name           string
		old            *model.AssistantTaskItem
		state          string
		opened, closed *time.Time
		closure        bool
		closureOpened  *time.Time
	}{
		{name: "create-open", state: "open", opened: &epoch},
		{name: "create-closed", state: "closed"},
		{name: "reopen", old: &model.AssistantTaskItem{State: "closed", OpenedAt: &previous, ClosedAt: &earlier}, state: "open", opened: &epoch, closed: &earlier},
		{name: "close", old: &model.AssistantTaskItem{State: "open", OpenedAt: &earlier}, state: "closed", opened: &earlier, closed: &epoch, closure: true, closureOpened: &earlier},
		{name: "close-legacy", old: &model.AssistantTaskItem{State: "open"}, state: "closed", closed: &epoch, closure: true},
		{name: "open-update", old: &model.AssistantTaskItem{State: "open", OpenedAt: &earlier, ClosedAt: &previous}, state: "open", opened: &earlier, closed: &previous},
		{name: "closed-update", old: &model.AssistantTaskItem{State: "closed", OpenedAt: &previous, ClosedAt: &earlier}, state: "closed", opened: &previous, closed: &earlier},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			input := itemInput()
			input.State = c.state
			var written model.AssistantTaskItem
			if c.old != nil {
				old := *c.old
				old.ID, old.OwnerUserID, old.TaskID, old.Key, old.Episode, old.Version = entryID, ownerID, taskID, input.Key, input.Episode, 3
				input.ItemVersion = ptr(int64(3))
				d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) { return old, nil }
				d.saveItem = func(_ context.Context, item model.AssistantTaskItem, _ int64) (bool, error) {
					written = item
					return true, nil
				}
			} else {
				d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
					return model.AssistantTaskItem{}, model.ErrNotFound
				}
				d.insertItem = func(_ context.Context, item model.AssistantTaskItem) (bool, error) {
					written = item
					return true, nil
				}
			}
			var closures []model.AssistantTaskItemClosure
			d.insertItemClosure = func(_ context.Context, closure model.AssistantTaskItemClosure) error {
				if written.ID == "" {
					t.Fatal("closure written before the item state")
				}
				closures = append(closures, closure)
				return nil
			}
			var events []model.AssistantTaskEvent
			d.insertEvent = func(_ context.Context, event model.AssistantTaskEvent) (bool, error) {
				if len(closures) == 0 {
					t.Fatal("retrospective written before the closure")
				}
				events = append(events, event)
				return true, nil
			}
			expectTaskWrite(t, d, task, true)
			result, err := New().SaveItem(context.Background(), d, botActor(), input)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(written.OpenedAt, c.opened) || !reflect.DeepEqual(written.ClosedAt, c.closed) || !reflect.DeepEqual(result.OpenedAt, c.opened) || !reflect.DeepEqual(result.ClosedAt, c.closed) {
				t.Fatalf("lifecycle times: opened=%v closed=%v", written.OpenedAt, written.ClosedAt)
			}
			if !c.closure {
				if len(closures) != 0 || len(events) != 0 {
					t.Fatalf("unexpected closures or events: %#v %#v", closures, events)
				}
				return
			}
			if len(closures) != 1 {
				t.Fatalf("want one closure, got %#v", closures)
			}
			if len(events) != 1 {
				t.Fatalf("want one retrospective, got %#v", events)
			}
			event := events[0]
			if !strictID(event.ID) || event.OwnerUserID != ownerID || event.TaskID != taskID || event.TargetBotID != botID || event.Type != "retrospective" || event.Attention || event.State != "pending" || !event.CreatedAt.Equal(epoch) || string(event.Payload) != `{"episode":"`+strconv.FormatInt(input.Episode, 10)+`","itemId":"`+entryID+`","reason":"item_closed"}` {
				t.Fatalf("retrospective: %#v %s", event, event.Payload)
			}
			got := closures[0]
			if got.ID == "" || !strictID(got.ID) || got.OwnerUserID != ownerID || got.TaskID != taskID || got.ItemID != entryID || got.Episode != input.Episode || !got.ClosedAt.Equal(epoch) || !reflect.DeepEqual(got.OpenedAt, c.closureOpened) {
				t.Fatalf("closure: %#v", got)
			}
		})
	}
}

func TestItemCloseFailuresDoNotCompleteTheWrite(t *testing.T) {
	for _, name := range []string{"save-conflict", "closure-failure", "event-failure", "event-identity"} {
		t.Run(name, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			input := itemInput()
			input.State, input.ItemVersion = "closed", ptr(int64(3))
			d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
				return model.AssistantTaskItem{ID: entryID, Key: input.Key, Episode: input.Episode, State: "open", Version: 3}, nil
			}
			d.saveItem = func(context.Context, model.AssistantTaskItem, int64) (bool, error) {
				return name != "save-conflict", nil
			}
			d.insertItemClosure = func(context.Context, model.AssistantTaskItemClosure) error {
				if name == "save-conflict" {
					t.Fatal("closure recorded for a rejected item write")
				}
				if name == "closure-failure" {
					return sentinel
				}
				return nil
			}
			d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) {
				if name == "save-conflict" || name == "closure-failure" {
					t.Fatal("retrospective emitted for a failed close")
				}
				if name == "event-identity" {
					return false, nil
				}
				return false, sentinel
			}
			d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
				t.Fatal("item write completed after a failed close")
				return false, nil
			}
			_, err := New().SaveItem(context.Background(), d, botActor(), input)
			switch name {
			case "save-conflict":
				requireCode(t, err, "version_conflict")
			case "event-identity":
				requireCode(t, err, "operation_conflict")
			default:
				if !errors.Is(err, sentinel) {
					t.Fatalf("close failure was not returned: %v", err)
				}
			}
		})
	}
}
