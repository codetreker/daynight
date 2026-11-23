package assistanttask

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestInquiryPagesObserveEffectiveStateBeforePagination(t *testing.T) {
	for _, state := range []string{"", "open", "timed_out", "answered"} {
		t.Run(state, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			locked := false
			d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
				if owner != ownerID || id != taskID || !lock {
					t.Fatal("page lacks task barrier")
				}
				locked = true
				return baseTask(), nil
			}
			observed := epoch
			d.now = func(context.Context) (time.Time, error) { return observed, nil }
			after := store.AssistantTaskPosition{CreatedAt: epoch.Add(-time.Hour), ID: operationID}
			c := cursor{Version: 1, Owner: ownerID, Task: taskID, Resource: "inquiries", State: state, Item: targetID, Position: after}
			data, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			input := PageInput{State: state, ItemID: targetID, Limit: 1, Cursor: base64.RawURLEncoding.EncodeToString(data)}
			reads, maintenance, saves, records, events := 0, 0, 0, 0, 0
			due := model.AssistantTaskInquiry{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, FromBotID: botID, State: "open", Deadline: epoch, CreatedAt: epoch.Add(-time.Minute), ItemID: ptr(targetID)}
			d.inquiries = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
				if q.DeadlineBefore != nil {
					maintenance++
					if q.State != "open" || q.Limit != 200 {
						t.Fatal("unbounded timeout maintenance")
					}
					return nil, nil
				}
				reads++
				if !locked || q.OwnerUserID != ownerID || q.TaskID != taskID || q.ItemID != targetID || q.Limit != 1 || q.After == nil || *q.After != after || q.State != state {
					t.Fatalf("page filters lost: %#v", q)
				}
				if (q.DeadlineAfter != nil) != (state == "open") || (q.IncludeExpiredOpen != nil) != (state == "timed_out") {
					t.Fatalf("wrong state predicates: %#v", q)
				}
				if q.DeadlineAfter != nil && !q.DeadlineAfter.Equal(epoch) || q.IncludeExpiredOpen != nil && !q.IncludeExpiredOpen.Equal(epoch) {
					t.Fatal("query cutoff changed")
				}
				first := due
				switch state {
				case "open":
					first.Deadline = epoch.Add(time.Second)
				case "answered":
					first.State = "answered"
				}
				second := due
				second.ID = targetID
				second.State = "timed_out"
				if state == "open" {
					second.State = "open"
					second.Deadline = epoch.Add(time.Minute)
				}
				if state == "answered" {
					second.State = "answered"
				}
				// Completing a read later does not turn its earlier observation into a
				// claim that these open questions were still live at the completion time.
				observed = epoch.Add(time.Minute)
				return []model.AssistantTaskInquiry{first, second}, nil
			}
			d.saveInquiry = func(_ context.Context, v model.AssistantTaskInquiry, prior string) (bool, error) {
				saves++
				if v.ID != entryID || v.State != "timed_out" || prior != "open" {
					t.Fatalf("wrong timeout: %#v", v)
				}
				return true, nil
			}
			d.insertRecord = func(_ context.Context, v model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
				records++
				if v.Kind != "unknown" {
					t.Fatal("wrong timeout record")
				}
				return v, nil
			}
			d.insertEvent = func(_ context.Context, v model.AssistantTaskEvent) (bool, error) {
				events++
				if v.Type != "inquiry_timed_out" || v.TargetBotID != botID || !v.Attention {
					t.Fatal("wrong timeout event")
				}
				return true, nil
			}
			d.saveTask = func(_ context.Context, v model.AssistantTask, c store.AssistantTaskCondition) (bool, error) {
				if v.Version != 8 || c.Version != 7 {
					t.Fatal("missing timeout version")
				}
				return true, nil
			}
			page, err := New().ListInquiries(context.Background(), d, userActor(), taskID, input)
			if err != nil || len(page.Items) != 1 || page.NextCursor == nil || !page.ObservedAt.Equal(epoch) || reads != 1 || maintenance != 1 {
				t.Fatalf("wrong page: %#v %v reads=%d maintenance=%d", page, err, reads, maintenance)
			}
			want := 0
			if state == "" || state == "timed_out" {
				want = 1
				if page.Items[0].State != "timed_out" {
					t.Fatal("expired inquiry returned open")
				}
			}
			if saves != want || records != want || events != want {
				t.Fatalf("timeout effects: %d %d %d want %d", saves, records, events, want)
			}
			input.Cursor = *page.NextCursor
			q, _, err := pageQuery(userActor(), taskID, "inquiries", input)
			if err != nil || q.After == nil || q.After.ID != entryID || !q.After.CreatedAt.Equal(due.CreatedAt) {
				t.Fatalf("timeout changed pagination position: %#v %v", q, err)
			}
		})
	}
}

func TestInquiryPageFailuresSuppressResults(t *testing.T) {
	for _, stage := range []string{"lock", "clock", "query", "save", "record", "event", "task", "finish"} {
		t.Run(stage, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			pageStarted := false
			d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
				pageStarted = true
				if stage == "lock" {
					return model.AssistantTask{}, sentinel
				}
				return baseTask(), nil
			}
			d.now = func(context.Context) (time.Time, error) {
				if pageStarted && stage == "clock" {
					return time.Time{}, sentinel
				}
				return epoch, nil
			}
			d.inquiries = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
				if q.DeadlineBefore != nil {
					return nil, nil
				}
				if stage == "query" {
					return nil, sentinel
				}
				return []model.AssistantTaskInquiry{{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, FromBotID: botID, State: "open", Deadline: epoch, CreatedAt: epoch}}, nil
			}
			d.saveInquiry = func(context.Context, model.AssistantTaskInquiry, string) (bool, error) {
				if stage == "save" {
					return false, sentinel
				}
				return true, nil
			}
			d.insertRecord = func(_ context.Context, v model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
				if stage == "record" {
					return v, sentinel
				}
				return v, nil
			}
			d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) {
				if stage == "event" {
					return false, sentinel
				}
				return true, nil
			}
			d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
				if stage == "task" {
					return false, sentinel
				}
				return true, nil
			}
			d.credential = func(context.Context, model.Principal) error {
				if pageStarted && stage == "finish" {
					return sentinel
				}
				return nil
			}
			page, err := New().ListInquiries(context.Background(), d, userActor(), taskID, PageInput{})
			if !errors.Is(err, sentinel) || len(page.Items) != 0 || page.NextCursor != nil {
				t.Fatalf("failure leaked page: %#v %v", page, err)
			}
		})
	}
}
