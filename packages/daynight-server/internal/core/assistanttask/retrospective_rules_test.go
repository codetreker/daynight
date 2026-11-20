package assistanttask

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestPeriodicRetrospectiveNeedsAnElapsedWindowWithANewerOutcome(t *testing.T) {
	week := 7 * 24 * time.Hour
	created := epoch.Add(-week)
	last := epoch.Add(-week - time.Hour)
	after, before := ptr(created.Add(time.Minute)), ptr(created.Add(-time.Minute))
	cases := []struct {
		name    string
		edit    func(*model.AssistantTask)
		outcome *time.Time
		since   time.Time
		due     bool
	}{
		{name: "creation-window", outcome: after, since: created, due: true},
		{name: "no-outcome", since: created},
		{name: "outcome-at-window-start", outcome: ptr(created), since: created},
		{name: "outcome-before-window", outcome: before, since: created},
		{name: "window-not-elapsed", edit: func(v *model.AssistantTask) { v.CreatedAt = created.Add(time.Nanosecond) }, outcome: after, since: created.Add(time.Nanosecond)},
		{name: "previous-retrospective", edit: func(v *model.AssistantTask) { v.CreatedAt = epoch.Add(-30 * week); v.LastRetrospectiveAt = &last }, outcome: ptr(last.Add(time.Second)), since: last, due: true},
		{name: "outcome-before-previous-retrospective", edit: func(v *model.AssistantTask) { v.CreatedAt = epoch.Add(-30 * week); v.LastRetrospectiveAt = &last }, outcome: ptr(last), since: last},
		{name: "recent-retrospective", edit: func(v *model.AssistantTask) { v.LastRetrospectiveAt = ptr(epoch.Add(-time.Hour)) }, outcome: ptr(epoch), since: epoch.Add(-time.Hour)},
		{name: "paused", edit: func(v *model.AssistantTask) { v.State = "paused" }, outcome: after, since: created},
		{name: "unowned", edit: func(v *model.AssistantTask) { v.HolderBotID = nil }, outcome: after, since: created},
		{name: "holder-deleted", edit: func(v *model.AssistantTask) { v.HolderDeleted = true }, outcome: after, since: created},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			task := baseTask()
			task.CreatedAt = created
			if c.edit != nil {
				c.edit(&task)
			}
			since, due := retrospectiveDue(task, c.outcome, epoch)
			if due != c.due || !since.Equal(c.since) {
				t.Fatalf("due=%v since=%v", due, since)
			}
		})
	}
}

// retrospectiveDAO configures one due candidate whose locked facts make the
// periodic retrospective due unless the caller changes them.
func retrospectiveDAO(t *testing.T, task model.AssistantTask) (*daoStub, *[]model.AssistantTaskEvent, *[]time.Time) {
	t.Helper()
	d := baseDAO(t, task)
	d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
	d.retrospectiveTasks = func(_ context.Context, q store.AssistantTaskQuery, cutoff time.Time) ([]string, error) {
		if !reflect.DeepEqual(q, store.AssistantTaskQuery{OwnerUserID: ownerID, TaskID: taskID, TargetBotID: botID, Limit: 200}) || !cutoff.Equal(epoch.Add(-7*24*time.Hour)) {
			t.Fatalf("retrospective candidates: %#v %v", q, cutoff)
		}
		return []string{taskID}, nil
	}
	d.task = func(_ context.Context, owner, id string, lock bool) (model.AssistantTask, error) {
		if owner != ownerID || id != taskID || !lock {
			t.Fatalf("retrospective without the task lock: %s %s %v", owner, id, lock)
		}
		return task, nil
	}
	d.latestOutcomeAt = func(_ context.Context, owner, id string) (*time.Time, error) {
		if owner != ownerID || id != taskID {
			t.Fatal("wrong outcome scope")
		}
		return ptr(epoch.Add(-time.Minute)), nil
	}
	events, marks := &[]model.AssistantTaskEvent{}, &[]time.Time{}
	d.insertEvent = func(_ context.Context, event model.AssistantTaskEvent) (bool, error) {
		*events = append(*events, event)
		return true, nil
	}
	d.markRetrospective = func(_ context.Context, owner, id string, at time.Time) (bool, error) {
		if owner != ownerID || id != taskID || len(*events) != 1 {
			t.Fatal("retrospective time moved without its event")
		}
		*marks = append(*marks, at)
		return true, nil
	}
	return d, events, marks
}

func TestEventPullWritesOnePeriodicRetrospectiveForTheHolder(t *testing.T) {
	task := baseTask()
	task.CreatedAt = epoch.Add(-8 * 24 * time.Hour)
	d, events, marks := retrospectiveDAO(t, task)
	d.task = func(_ context.Context, _ string, _ string, lock bool) (model.AssistantTask, error) {
		// Only the page read after maintenance may skip the task lock.
		if !lock && len(*events) == 0 {
			t.Fatal("retrospective checked without the task lock")
		}
		return task, nil
	}
	d.events = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
		if len(*events) != 1 {
			t.Fatal("event page read before the retrospective was written")
		}
		return *events, nil
	}
	page, err := New().ListEvents(context.Background(), d, userActor(), taskID, PageInput{TargetBotID: botID})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("page: %#v %v", page, err)
	}
	event := (*events)[0]
	if !strictID(event.ID) || event.TaskID != taskID || event.OwnerUserID != ownerID || event.TargetBotID != botID || event.Type != "retrospective" || event.Attention || event.State != "pending" || !event.CreatedAt.Equal(epoch) || string(event.Payload) != `{"reason":"periodic","since":"2026-11-04T12:00:00Z"}` {
		t.Fatalf("retrospective: %#v %s", event, event.Payload)
	}
	if len(*marks) != 1 || !(*marks)[0].Equal(epoch) {
		t.Fatalf("retrospective time: %v", *marks)
	}
}

func TestEventPullSkipsRetrospectivesThatAreNoLongerDue(t *testing.T) {
	for _, name := range []string{"moved-window", "paused", "no-outcome"} {
		t.Run(name, func(t *testing.T) {
			task := baseTask()
			task.CreatedAt = epoch.Add(-8 * 24 * time.Hour)
			switch name {
			case "moved-window":
				// A concurrent pull committed first; the locked reread sees its time.
				task.LastRetrospectiveAt = ptr(epoch.Add(-time.Second))
			case "paused":
				task.State = "paused"
			}
			d, events, marks := retrospectiveDAO(t, task)
			if name == "no-outcome" {
				d.latestOutcomeAt = func(context.Context, string, string) (*time.Time, error) { return nil, nil }
			}
			if err := New().maintain(context.Background(), d, userActor(), taskID, botID, true); err != nil {
				t.Fatal(err)
			}
			if len(*events) != 0 || len(*marks) != 0 {
				t.Fatalf("stale retrospective: %#v %v", *events, *marks)
			}
		})
	}
}

func TestInquiryReadsDoNotRunRetrospectives(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
	d.retrospectiveTasks = func(context.Context, store.AssistantTaskQuery, time.Time) ([]string, error) {
		t.Fatal("inquiry read selected retrospectives")
		return nil, nil
	}
	if err := New().expireInquiries(context.Background(), d, userActor(), taskID, botID); err != nil {
		t.Fatal(err)
	}
}

func TestEventPullLocksInquiryAndRetrospectiveTasksOnceInIDOrder(t *testing.T) {
	first, second := "12121212-1212-4212-8212-121212121212", "13131313-1313-4313-8313-131313131313"
	d := baseDAO(t, baseTask())
	d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) {
		return []model.AssistantTaskInquiry{{ID: entryID, TaskID: second}}, nil
	}
	d.retrospectiveTasks = func(context.Context, store.AssistantTaskQuery, time.Time) ([]string, error) {
		return []string{second, first}, nil
	}
	var locks []string
	d.task = func(_ context.Context, _ string, id string, lock bool) (model.AssistantTask, error) {
		if !lock {
			t.Fatal("candidate read without the task lock")
		}
		locks = append(locks, id)
		task := baseTask()
		task.ID = id
		return task, nil
	}
	d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
		return model.AssistantTaskInquiry{ID: entryID, TaskID: second, State: "answered"}, nil
	}
	var outcomes []string
	d.latestOutcomeAt = func(_ context.Context, _ string, id string) (*time.Time, error) {
		outcomes = append(outcomes, id)
		return nil, nil
	}
	if err := New().maintain(context.Background(), d, userActor(), "", botID, true); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(locks, []string{first, second}) || !reflect.DeepEqual(outcomes, []string{second, first}) {
		t.Fatalf("locks=%v outcomes=%v", locks, outcomes)
	}
}

func TestPeriodicRetrospectiveFailuresStopThePull(t *testing.T) {
	for _, stage := range []string{"candidates", "outcome", "now", "event", "event-identity", "mark", "mark-skipped"} {
		t.Run(stage, func(t *testing.T) {
			task := baseTask()
			task.CreatedAt = epoch.Add(-8 * 24 * time.Hour)
			d, _, _ := retrospectiveDAO(t, task)
			switch stage {
			case "candidates":
				d.retrospectiveTasks = func(context.Context, store.AssistantTaskQuery, time.Time) ([]string, error) { return nil, sentinel }
			case "outcome":
				d.latestOutcomeAt = func(context.Context, string, string) (*time.Time, error) { return nil, sentinel }
			case "now":
				calls := 0
				d.now = func(context.Context) (time.Time, error) {
					// The candidate cutoff reads time once before the locked recheck.
					if calls++; calls > 1 {
						return time.Time{}, sentinel
					}
					return epoch, nil
				}
			case "event":
				d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) { return false, sentinel }
			case "event-identity":
				d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) { return false, nil }
			case "mark":
				d.markRetrospective = func(context.Context, string, string, time.Time) (bool, error) { return false, sentinel }
			case "mark-skipped":
				d.markRetrospective = func(context.Context, string, string, time.Time) (bool, error) { return false, nil }
			}
			if stage != "event" && stage != "event-identity" && stage != "mark" && stage != "mark-skipped" {
				d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) {
					t.Fatal("retrospective written after a failed read")
					return false, nil
				}
			}
			err := New().maintain(context.Background(), d, userActor(), taskID, botID, true)
			switch stage {
			case "event-identity":
				requireCode(t, err, "operation_conflict")
			case "mark-skipped":
				requireCode(t, err, "version_conflict")
			default:
				if !errors.Is(err, sentinel) {
					t.Fatalf("lost %s failure: %v", stage, err)
				}
			}
		})
	}
}
