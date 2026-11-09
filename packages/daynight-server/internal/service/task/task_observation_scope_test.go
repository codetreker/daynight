package task_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskObservationKeepsEpochAndTaskInOneSnapshot(t *testing.T) {
	f := newTaskReadFixture(t)
	_, target, _ := taskMockModels()
	target.Title = "Before replacement"
	beforeEpoch, afterEpoch := taskReadID(90), taskReadID(91)
	f.reader.TaskFn = func(ctx context.Context, projectID, id string) (model.Task, error) {
		f.requireProject(ctx, projectID)
		if id != target.ID {
			t.Fatal("observation target changed")
		}
		return target, nil
	}
	f.reader.TaskCacheEpochFn = func(ctx context.Context, projectID string) (string, error) {
		f.requireProject(ctx, projectID)
		return beforeEpoch, nil
	}
	tasks := taskservice.NewTasks(f.store)
	old, err := tasks.Observe(f.ctx, f.principal, f.project.ID, target.ID)
	if err != nil || old.Task.Title != target.Title || old.Epoch != beforeEpoch || f.reads != 1 {
		t.Fatalf("Task/epoch scope: %#v %v", old, err)
	}
	after := target
	after.Title = "After replacement"
	f.reader.TaskFn = func(ctx context.Context, projectID, id string) (model.Task, error) {
		f.requireProject(ctx, projectID)
		if id != after.ID {
			t.Fatal("fresh target changed")
		}
		return after, nil
	}
	f.reader.TaskCacheEpochFn = func(ctx context.Context, projectID string) (string, error) {
		f.requireProject(ctx, projectID)
		return afterEpoch, nil
	}
	fresh, err := tasks.Observe(f.ctx, f.principal, f.project.ID, target.ID)
	if err != nil || !reflect.DeepEqual(fresh.Task, after) || fresh.Epoch != afterEpoch || fresh.Task.Version != target.Version || f.reads != 2 {
		t.Fatalf("fresh Task/epoch scope: %#v %v", fresh, err)
	}
	if !reflect.DeepEqual(old.Task, target) || old.Epoch != beforeEpoch {
		t.Fatal("new snapshot changed old observation")
	}
}
