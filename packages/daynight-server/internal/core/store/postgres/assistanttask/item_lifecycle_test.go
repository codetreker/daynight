package assistanttask_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestItemLifecycleTimesRoundTripBesideLegacyRows(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	opened := f.task.CreatedAt.Add(time.Minute)
	closed := opened.Add(time.Hour)
	item := model.AssistantTaskItem{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Key: "build", State: "open", Episode: 1, Version: 1, AppState: json.RawMessage(`{}`), CreatedAt: opened, UpdatedAt: opened, OpenedAt: &opened}
	// Rows written before lifecycle tracking omit both times entirely.
	legacy := uuid.NewString()
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO assistant_task_items(id,owner_user_id,task_id,request_fingerprint,key,episode,state,category,app_state,version,created_at,updated_at) VALUES($1,$2,$3,'legacy','legacy',1,'open','','{}',1,$4,$4)`, legacy, f.owner, f.task.ID, f.task.CreatedAt); err != nil {
		t.Fatal(err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		ok, err := d.InsertItem(ctx, item)
		if err == nil && !ok {
			t.Fatal("item insert skipped")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Item(ctx, f.owner, f.task.ID, item.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(got, item) {
			t.Fatalf("open item roundtrip: %#v != %#v", got, item)
		}
		closedItem := item
		closedItem.State, closedItem.Version, closedItem.UpdatedAt, closedItem.ClosedAt = "closed", 2, closed, &closed
		ok, err := d.SaveItem(ctx, closedItem, 1)
		if err != nil || !ok {
			t.Fatalf("close item: %v %v", ok, err)
		}
		item = closedItem
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		page, err := d.Items(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, Limit: 10})
		if err != nil {
			return err
		}
		if len(page) != 2 || page[0].ID != legacy || page[0].OpenedAt != nil || page[0].ClosedAt != nil || !reflect.DeepEqual(page[1], item) {
			t.Fatalf("item page lost lifecycle times: %#v", page)
		}
		return nil
	})
}

func TestItemClosuresAppendAndFollowTaskContent(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	item := uuid.NewString()
	opened := f.task.CreatedAt.Add(time.Minute)
	closures := []model.AssistantTaskItemClosure{
		{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: item, Episode: 1, ClosedAt: opened},
		{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: item, Episode: 1, OpenedAt: &opened, ClosedAt: opened.Add(time.Hour)},
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, closure := range closures {
			if err := d.InsertItemClosure(ctx, closure); err != nil {
				return err
			}
		}
		return nil
	})
	// A closure shares its transaction with the item write; a rolled back
	// close leaves no closure behind.
	rejected := errors.New("rejected close")
	if _, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
		if err := s.AssistantTaskDAO().InsertItemClosure(ctx, model.AssistantTaskItemClosure{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: item, Episode: 2, ClosedAt: opened}); err != nil {
			return err
		}
		return rejected
	}); !errors.Is(err, rejected) {
		t.Fatalf("rolled back write: %v", err)
	}
	read := func() []model.AssistantTaskItemClosure {
		t.Helper()
		rows, err := f.db.Pool.Query(ctx, `SELECT id::text,owner_user_id::text,task_id::text,item_id::text,episode,opened_at,closed_at FROM assistant_task_item_closures WHERE task_id=$1 ORDER BY closed_at`, f.task.ID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var result []model.AssistantTaskItemClosure
		for rows.Next() {
			var v model.AssistantTaskItemClosure
			if err := rows.Scan(&v.ID, &v.OwnerUserID, &v.TaskID, &v.ItemID, &v.Episode, &v.OpenedAt, &v.ClosedAt); err != nil {
				t.Fatal(err)
			}
			v.ClosedAt = v.ClosedAt.UTC()
			if v.OpenedAt != nil {
				utc := v.OpenedAt.UTC()
				v.OpenedAt = &utc
			}
			result = append(result, v)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if got := read(); !reflect.DeepEqual(got, closures) {
		t.Fatalf("closures: %#v != %#v", got, closures)
	}
	f.write(t, func(d store.AssistantTaskDAO) error { return d.DeleteTaskContent(ctx, uuid.NewString(), f.task.ID) })
	if got := read(); len(got) != 2 {
		t.Fatalf("foreign owner purged closures: %#v", got)
	}
	f.write(t, func(d store.AssistantTaskDAO) error { return d.DeleteTaskContent(ctx, f.owner, f.task.ID) })
	if got := read(); len(got) != 0 {
		t.Fatalf("purge left closures: %#v", got)
	}
}
