package assistanttask_test

import (
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestEventTypeFiltersAndPausedTaskExclusion(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	paused := f.task
	paused.ID, paused.State, paused.Version = uuid.NewString(), "paused", 1
	bot := uuid.NewString()
	ids := map[string]string{}
	f.write(t, func(d store.AssistantTaskDAO) error {
		if _, err := d.InsertTask(ctx, paused); err != nil {
			return err
		}
		i := 0
		for _, task := range []string{f.task.ID, paused.ID} {
			for _, kind := range []string{"inbound", "report"} {
				id := uuid.NewString()
				ids[task+"/"+kind] = id
				event := model.AssistantTaskEvent{ID: id, OwnerUserID: f.owner, TaskID: task, TargetBotID: bot, Type: kind, State: "pending", RequestFingerprint: "event", Payload: json.RawMessage(`{}`), CreatedAt: f.task.CreatedAt.Add(time.Duration(i) * time.Second)}
				i++
				if _, err := d.InsertEvent(ctx, event); err != nil {
					return err
				}
			}
		}
		return nil
	})
	list := func(q store.AssistantTaskQuery) []string {
		t.Helper()
		q.OwnerUserID, q.TargetBotID = f.owner, bot
		if q.Limit == 0 {
			q.Limit = 10
		}
		var got []string
		f.write(t, func(d store.AssistantTaskDAO) error {
			events, err := d.Events(ctx, q)
			for _, event := range events {
				got = append(got, event.ID)
			}
			return err
		})
		return got
	}
	active, pausedID := f.task.ID, paused.ID
	for _, tc := range []struct {
		name  string
		query store.AssistantTaskQuery
		want  []string
	}{
		{"unfiltered", store.AssistantTaskQuery{}, []string{ids[active+"/inbound"], ids[active+"/report"], ids[pausedID+"/inbound"], ids[pausedID+"/report"]}},
		{"inbound with paused tasks", store.AssistantTaskQuery{EventType: "inbound"}, []string{ids[active+"/inbound"], ids[pausedID+"/inbound"]}},
		{"inbound without paused tasks", store.AssistantTaskQuery{EventType: "inbound", ExcludePausedTasks: true}, []string{ids[active+"/inbound"]}},
		{"paused task scope", store.AssistantTaskQuery{TaskID: pausedID, EventType: "inbound", ExcludePausedTasks: true}, nil},
		{"exclude inbound", store.AssistantTaskQuery{ExcludeEventType: "inbound"}, []string{ids[active+"/report"], ids[pausedID+"/report"]}},
		{"exclude inbound after cursor", store.AssistantTaskQuery{ExcludeEventType: "inbound", Limit: 1, After: &store.AssistantTaskPosition{CreatedAt: f.task.CreatedAt.Add(time.Second), ID: ids[active+"/report"]}}, []string{ids[pausedID+"/report"]}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := list(tc.query); !slices.Equal(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	// Resuming the task makes its held inbound events selectable again.
	paused.State, paused.Version = "active", 2
	f.write(t, func(d store.AssistantTaskDAO) error {
		ok, err := d.SaveTask(ctx, paused, store.AssistantTaskCondition{Version: 1})
		if err == nil && !ok {
			t.Fatal("resume was not saved")
		}
		return err
	})
	if got := list(store.AssistantTaskQuery{EventType: "inbound", ExcludePausedTasks: true}); !slices.Equal(got, []string{ids[active+"/inbound"], ids[pausedID+"/inbound"]}) {
		t.Fatalf("resumed task events: %v", got)
	}
}
