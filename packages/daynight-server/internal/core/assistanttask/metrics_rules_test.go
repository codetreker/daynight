package assistanttask

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMetricsReadOwnedTaskForTrailingWindow(t *testing.T) {
	d := baseDAO(t, baseTask())
	want := model.AssistantTaskMetrics{ObservedAt: epoch, WindowStart: epoch.Add(-MetricsWindow), WindowEnd: epoch, ActionCount: 3}
	d.metrics = func(_ context.Context, owner, task string, window time.Duration) (model.AssistantTaskMetrics, error) {
		if owner != ownerID || task != taskID || window != 30*24*time.Hour {
			t.Fatalf("wrong metrics scope %s %s %s", owner, task, window)
		}
		return want, nil
	}
	got, err := New().Metrics(context.Background(), d, userActor(), taskID)
	if err != nil || got != want {
		t.Fatalf("metrics=%+v err=%v", got, err)
	}
}

func TestMetricsRefusalsAndFailuresSkipOrStopTheAggregate(t *testing.T) {
	for _, test := range []struct {
		name, id, code string
		task           func(model.AssistantTask) model.AssistantTask
		fail           bool
	}{
		{name: "invalid id", id: "bad", code: "invalid_input"},
		{name: "foreign task", id: taskID, code: "forbidden", task: func(v model.AssistantTask) model.AssistantTask { v.OwnerUserID = targetID; return v }},
		{name: "deleted task", id: taskID, code: "task_deleted", task: func(v model.AssistantTask) model.AssistantTask { v.State = "deleted"; return v }},
		{name: "storage failure", id: taskID, fail: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			task := baseTask()
			if test.task != nil {
				task = test.task(task)
			}
			d := baseDAO(t, task)
			called := false
			d.metrics = func(context.Context, string, string, time.Duration) (model.AssistantTaskMetrics, error) {
				called = true
				return model.AssistantTaskMetrics{}, sentinel
			}
			_, err := New().Metrics(context.Background(), d, userActor(), test.id)
			if test.fail {
				if !called || err != sentinel {
					t.Fatalf("storage failure not returned: %v", err)
				}
				return
			}
			requireCode(t, err, test.code)
			if called {
				t.Fatal("refused read reached the aggregate")
			}
		})
	}
}
