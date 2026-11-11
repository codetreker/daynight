package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestGoalProgressOnSelectedPageAndDirectRead(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	f.read(ctx)
	goal, empty := f.target, f.target
	goal.Type, goal.ID = model.TaskTypeGoal, "20000000-0000-4000-8000-000000000001"
	empty.Type, empty.ID = model.TaskTypeGoal, "20000000-0000-4000-8000-000000000002"
	calls := 0
	failure := errors.New("aggregate failed")
	f.reader.GoalProgressesFn = func(actual context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
		calls++
		if actual != ctx || project != f.project.ID {
			t.Fatal("progress snapshot changed")
		}
		if calls == 1 {
			if !reflect.DeepEqual(ids, []string{goal.ID, empty.ID}) {
				t.Fatalf("selected goals %v", ids)
			}
			return map[string]model.GoalProgress{goal.ID: {Total: 3, Done: 1, Cancelled: 1, Unfinished: 1}, empty.ID: {}}, nil
		}
		if !reflect.DeepEqual(ids, []string{goal.ID}) {
			t.Fatalf("show goals %v", ids)
		}
		return nil, failure
	}
	f.reader.TasksFn = func(_ context.Context, _ string, _ store.TaskQuery) (store.TaskPage, error) {
		return store.TaskPage{Items: []model.Task{goal, empty}}, nil
	}
	page, err := f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 2}})
	if err != nil || len(page.Items) != 2 || calls != 1 || page.Items[0].Progress == nil || page.Items[0].Progress.Total != 3 || page.Items[1].Progress == nil || *page.Items[1].Progress != (model.GoalProgress{}) {
		t.Fatalf("list progress: %#v %v calls=%d", page, err, calls)
	}
	f.reader.TaskFn = func(context.Context, string, string) (model.Task, error) { return goal, nil }
	if got, err := f.tasks.Get(ctx, f.principal, f.project.ID, goal.ID); !errors.Is(err, failure) || got.ID != "" {
		t.Fatalf("progress failure exposed result: %#v %v", got, err)
	}
}

func TestGoalProgressDirectReadUsesSelectedSnapshot(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	f.read(ctx)
	goal := f.target
	goal.Type = model.TaskTypeGoal
	f.reader.TaskFn = func(actual context.Context, project, id string) (model.Task, error) {
		if actual != ctx || project != f.project.ID || id != goal.ID {
			t.Fatal("direct read changed scope")
		}
		return goal, nil
	}
	calls := 0
	f.reader.GoalProgressesFn = func(actual context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
		calls++
		if actual != ctx || project != f.project.ID || !reflect.DeepEqual(ids, []string{goal.ID}) {
			t.Fatal("progress scope changed")
		}
		return map[string]model.GoalProgress{goal.ID: {}}, nil
	}
	got, err := f.tasks.Get(ctx, f.principal, f.project.ID, goal.ID)
	if err != nil || calls != 1 || got.Progress == nil || *got.Progress != (model.GoalProgress{}) || got.Version != goal.Version {
		t.Fatalf("direct progress: %#v %v calls=%d", got, err, calls)
	}
}
