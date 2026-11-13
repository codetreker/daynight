package assistanttask

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestPaginationCursorBindsOwnerResourceAndFilters(t *testing.T) {
	input := PageInput{Limit: 1, ItemID: entryID}
	q, c, err := pageQuery(userActor(), taskID, "records", input)
	if err != nil || q.Limit != 1 || q.ItemID != entryID {
		t.Fatal(q, err)
	}
	items := []model.AssistantTaskRecord{{ID: operationID, CreatedAt: epoch}, {ID: targetID, CreatedAt: epoch}}
	page, err := makePage(items, q.Limit, c, epoch, func(v model.AssistantTaskRecord) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != operationID || page.NextCursor == nil {
		t.Fatalf("wrong lookahead page: %#v %v", page, err)
	}
	encoded, err := base64.RawURLEncoding.DecodeString(*page.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	var decoded cursor
	if err = json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Owner != ownerID || decoded.Task != taskID || decoded.Resource != "records" || decoded.Item != entryID || decoded.Position.ID != operationID || decoded.Position.CreatedAt != epoch {
		t.Fatalf("incomplete cursor scope: %#v", decoded)
	}
	input.Cursor = *page.NextCursor
	next, _, err := pageQuery(userActor(), taskID, "records", input)
	if err != nil || next.After == nil || next.After.ID != operationID {
		t.Fatal(next, err)
	}
	for _, change := range []string{"owner", "task", "resource", "item", "state", "target"} {
		t.Run(change, func(t *testing.T) {
			actor, id, resource, changed := userActor(), taskID, "records", input
			switch change {
			case "owner":
				actor.Principal.UserID = targetID
			case "task":
				id = operationID
			case "resource":
				resource = "inquiries"
			case "item":
				changed.ItemID = targetID
			case "state":
				changed.State = "open"
			case "target":
				changed.TargetBotID = targetID
			}
			_, _, err := pageQuery(actor, id, resource, changed)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestPaginationRejectsInvalidCursorPositionsAndLimits(t *testing.T) {
	for _, name := range []string{"negative", "large", "bad-base64", "bad-json", "missing-time", "bad-id", "version", "manual-zero", "manual-leading-zero"} {
		t.Run(name, func(t *testing.T) {
			input, resource := PageInput{}, "records"
			c := cursor{Version: 1, Owner: ownerID, Task: taskID, Resource: resource, Position: store.AssistantTaskPosition{CreatedAt: epoch, ID: entryID}}
			switch name {
			case "negative":
				input.Limit = -1
			case "large":
				input.Limit = 201
			case "bad-base64":
				input.Cursor = "!"
			case "bad-json":
				input.Cursor = base64.RawURLEncoding.EncodeToString([]byte(`invalid`))
			case "missing-time":
				c.Position.CreatedAt = time.Time{}
			case "bad-id":
				c.Position.ID = "bad"
			case "version":
				c.Version = 2
			case "manual-zero":
				c.Resource, resource, c.Position.ID = "manuals", "manuals", "0"
			case "manual-leading-zero":
				c.Resource, resource, c.Position.ID = "manuals", "manuals", "01"
			}
			if input.Cursor == "" && input.Limit == 0 {
				data, err := json.Marshal(c)
				if err != nil {
					t.Fatal(err)
				}
				input.Cursor = base64.RawURLEncoding.EncodeToString(data)
			}
			_, _, err := pageQuery(userActor(), taskID, resource, input)
			requireCode(t, err, "invalid_input")
		})
	}
	q, _, err := pageQuery(userActor(), taskID, "records", PageInput{})
	if err != nil || q.Limit != 50 {
		t.Fatal(q, err)
	}
	page, err := makePage([]string(nil), 200, cursor{}, epoch, func(string) store.AssistantTaskPosition {
		t.Fatal("empty page queried position")
		return store.AssistantTaskPosition{}
	})
	if err != nil || page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatal(page, err)
	}
}

func TestEachListRejectsUnsupportedStateAndFilter(t *testing.T) {
	for _, tc := range []struct {
		resource string
		input    PageInput
	}{
		{"tasks", PageInput{State: "deleted"}}, {"tasks", PageInput{ItemID: entryID}},
		{"manuals", PageInput{State: "active"}}, {"manuals", PageInput{TargetBotID: botID}},
		{"appendix", PageInput{State: "open"}}, {"appendix", PageInput{ItemID: entryID}},
		{"proposals", PageInput{State: "active"}}, {"items", PageInput{State: "pending"}},
		{"records", PageInput{State: "open"}}, {"records", PageInput{TargetBotID: botID}},
		{"events", PageInput{State: "open"}}, {"events", PageInput{ItemID: entryID}},
		{"inquiries", PageInput{State: "pending"}}, {"inquiries", PageInput{TargetBotID: botID}},
	} {
		t.Run(tc.resource+"/"+tc.input.State+tc.input.ItemID+tc.input.TargetBotID, func(t *testing.T) {
			_, _, err := pageQuery(userActor(), taskID, tc.resource, tc.input)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestInvalidInquiryListDoesNotPerformTimeoutWrites(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
		t.Fatal("invalid list reached timeout processing")
		return nil, nil
	}
	_, err := New().ListInquiries(context.Background(), d, userActor(), taskID, PageInput{State: "invalid"})
	requireCode(t, err, "invalid_input")
}

func TestResourceListsPassExactQueryAndReturnLookaheadCursor(t *testing.T) {
	for _, resource := range []string{"tasks", "manuals", "appendix", "proposals", "items", "records", "inquiries", "events", "global-events"} {
		t.Run(resource, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			m, input := New(), PageInput{Limit: 1}
			reads := 0
			check := func(q store.AssistantTaskQuery) {
				reads++
				wantTask := taskID
				if resource == "tasks" || resource == "global-events" {
					wantTask = ""
				}
				if q.OwnerUserID != ownerID || q.TaskID != wantTask || q.Limit != 1 || q.After != nil {
					t.Fatalf("wrong list scope: %#v", q)
				}
			}
			var next *string
			var err error
			switch resource {
			case "tasks":
				d.tasks = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTask, error) {
					check(q)
					a, b := baseTask(), baseTask()
					b.ID = operationID
					return []model.AssistantTask{a, b}, nil
				}
				page, e := m.List(context.Background(), d, userActor(), input)
				next, err = page.NextCursor, e
				if len(page.Items) != 1 || page.Items[0].Claim.ObservedAt != epoch {
					t.Fatal("lost task snapshot projection")
				}
			case "manuals":
				d.manuals = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskManual, error) {
					check(q)
					return []model.AssistantTaskManual{{Version: 1, CreatedAt: epoch}, {Version: 2, CreatedAt: epoch}}, nil
				}
				page, e := m.ListManuals(context.Background(), d, userActor(), taskID, input)
				next, err = page.NextCursor, e
			case "appendix":
				d.appendices = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskAppendix, error) {
					check(q)
					return []model.AssistantTaskAppendix{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}, nil
				}
				page, e := m.ListAppendix(context.Background(), d, userActor(), taskID, input)
				next, err = page.NextCursor, e
			case "proposals":
				d.proposals = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error) {
					check(q)
					return []model.AssistantTaskProposal{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}, nil
				}
				page, e := m.ListProposals(context.Background(), d, userActor(), taskID, input)
				next, err = page.NextCursor, e
			case "items":
				d.items = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskItem, error) {
					check(q)
					return []model.AssistantTaskItem{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}, nil
				}
				page, e := m.ListItems(context.Background(), d, userActor(), taskID, input)
				next, err = page.NextCursor, e
			case "records":
				input.ItemID = operationID
				d.records = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskRecord, error) {
					check(q)
					if q.ItemID != operationID {
						t.Fatal("lost item filter")
					}
					return []model.AssistantTaskRecord{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}, nil
				}
				page, e := m.ListRecords(context.Background(), d, userActor(), taskID, input)
				next, err = page.NextCursor, e
			case "inquiries":
				input.ItemID = operationID
				d.inquiries = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
					if q.DeadlineBefore != nil {
						return nil, nil
					}
					check(q)
					if q.ItemID != operationID {
						t.Fatal("lost inquiry item filter")
					}
					return []model.AssistantTaskInquiry{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}, nil
				}
				page, e := m.ListInquiries(context.Background(), d, userActor(), taskID, input)
				next, err = page.NextCursor, e
			case "events", "global-events":
				input.TargetBotID = botID
				d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
				d.events = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
					check(q)
					if q.TargetBotID != botID {
						t.Fatal("lost event target")
					}
					return []model.AssistantTaskEvent{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}, nil
				}
				id := taskID
				if resource == "global-events" {
					id = ""
				}
				page, e := m.ListEvents(context.Background(), d, userActor(), id, input)
				next, err = page.NextCursor, e
			}
			if err != nil || next == nil || reads != 1 {
				t.Fatalf("list %s: cursor=%v reads=%d err=%v", resource, next, reads, err)
			}
		})
	}
}

func TestListErrorsRetainCauseAndRejectCrossOwnerProjection(t *testing.T) {
	for _, name := range []string{"storage", "foreign-owner", "final-auth"} {
		t.Run(name, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			d.tasks = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTask, error) {
				if name == "storage" {
					return nil, sentinel
				}
				task := baseTask()
				if name == "foreign-owner" {
					task.OwnerUserID = targetID
				}
				return []model.AssistantTask{task}, nil
			}
			if name == "final-auth" {
				calls := 0
				d.credential = func(context.Context, model.Principal) error {
					calls++
					if calls == 2 {
						return sentinel
					}
					return nil
				}
			}
			page, err := New().List(context.Background(), d, userActor(), PageInput{})
			if name == "foreign-owner" {
				requireCode(t, err, "forbidden")
			} else if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(page, model.AssistantTaskPage[TaskResult]{}) {
				t.Fatal("failed list leaked partial rows")
			}
		})
	}
}

func TestTriggerValidationRetainsExplicitSchedule(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{"", "null"}, {"null", "null"}, {`{ "minutes":1, "kind":"interval" }`, `{"kind":"interval","minutes":1}`},
		{`{"timeZone":"Asia/Shanghai","time":"00:05","kind":"daily"}`, `{"kind":"daily","time":"00:05","timeZone":"Asia/Shanghai"}`},
	} {
		got, err := normalizeTrigger(json.RawMessage(tc.raw))
		if err != nil || string(got) != tc.want {
			t.Errorf("trigger %s: %s %v", tc.raw, got, err)
		}
	}
	for _, raw := range []string{`bad`, `[]`, `true`, `{}`, `{"kind":5}`, `{"kind":"other"}`, `{"kind":"interval"}`, `{"kind":"interval","minutes":0}`, `{"kind":"interval","minutes":1.5}`, `{"kind":"interval","minutes":"2"}`, `{"kind":"interval","minutes":2,"extra":1}`, `{"kind":"daily","time":"12:30"}`, `{"kind":"daily","time":"24:00","timeZone":"UTC"}`, `{"kind":"daily","time":"1:30","timeZone":"UTC"}`, `{"kind":"daily","time":"01:30","timeZone":"Local"}`, `{"kind":"daily","time":"01:30","timeZone":"Invalid/Zone"}`} {
		t.Run(raw, func(t *testing.T) {
			_, err := normalizeTrigger(json.RawMessage(raw))
			requireCode(t, err, "invalid_input")
		})
	}
}
