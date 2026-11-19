package assistanttask

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
			expectTaskWrite(t, d, task, true)
			result, err := New().SaveItem(context.Background(), d, botActor(), input)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(written.OpenedAt, c.opened) || !reflect.DeepEqual(written.ClosedAt, c.closed) || !reflect.DeepEqual(result.OpenedAt, c.opened) || !reflect.DeepEqual(result.ClosedAt, c.closed) {
				t.Fatalf("lifecycle times: opened=%v closed=%v", written.OpenedAt, written.ClosedAt)
			}
			if !c.closure {
				if len(closures) != 0 {
					t.Fatalf("unexpected closures: %#v", closures)
				}
				return
			}
			if len(closures) != 1 {
				t.Fatalf("want one closure, got %#v", closures)
			}
			got := closures[0]
			if got.ID == "" || !strictID(got.ID) || got.OwnerUserID != ownerID || got.TaskID != taskID || got.ItemID != entryID || got.Episode != input.Episode || !got.ClosedAt.Equal(epoch) || !reflect.DeepEqual(got.OpenedAt, c.closureOpened) {
				t.Fatalf("closure: %#v", got)
			}
		})
	}
}

func TestItemCloseFailuresDoNotCompleteTheWrite(t *testing.T) {
	for _, name := range []string{"save-conflict", "closure-failure"} {
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
				return sentinel
			}
			_, err := New().SaveItem(context.Background(), d, botActor(), input)
			if name == "save-conflict" {
				requireCode(t, err, "version_conflict")
			} else if !errors.Is(err, sentinel) {
				t.Fatalf("closure failure was not returned: %v", err)
			}
		})
	}
}
