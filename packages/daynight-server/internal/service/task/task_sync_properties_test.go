package task_test

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskSyncPropertiesAndVersionUseOneSnapshot(t *testing.T) {
	f := newTaskReadFixture(t)
	epoch := taskReadID(90)
	raw, err := taskproperties.ParseInput("pullRequests", "[{\"url\":\"before\\u0000中文\",\"title\":\"same\"},{\"url\":\"before\\u0000中文\",\"title\":\"same\"}]")
	if err != nil {
		t.Fatal(err)
	}
	before := taskReadView(taskReadID(1), "Atomic property snapshot", 2, f.observed)
	before.Properties = model.TaskProperties{"pullRequests": raw}
	after := before
	after.Version = 3
	after.UpdatedAt = before.UpdatedAt.Add(time.Second)
	after.Properties = model.TaskProperties{"pullRequests": json.RawMessage("[]")}
	removed := after
	removed.Version = 4
	removed.UpdatedAt = after.UpdatedAt.Add(time.Second)
	removed.Properties = model.TaskProperties{}
	var first model.TaskSync
	for index, row := range []model.TaskViewRecord{before, after, removed} {
		request := taskservice.TaskSyncRequest{Epoch: epoch}
		var wantLower *time.Time
		if index > 0 {
			since := before.UpdatedAt
			if index == 2 {
				since = after.UpdatedAt
			}
			request.Since = &since
			wantLower = pointer(since.Add(-10 * time.Second))
		}
		sync := f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
			if !model.EqualOptional(lower, wantLower) {
				t.Fatalf("property delta lower=%v want=%v", lower, wantLower)
			}
			return []model.TaskViewRecord{row}, nil
		}, []model.TaskAssigneeFact{}, 10*time.Second)
		result, err := sync.Get(f.ctx, f.principal, f.project.ID, request)
		if err != nil || result.Mode != "delta" || result.Epoch != epoch || len(result.Tasks) != 1 || result.Tasks[0].Version != row.Version || !taskproperties.Equal(result.Tasks[0].Properties, row.Properties) || result.Tasks[0].Properties == nil {
			t.Fatalf("version/property scope changed: %#v %v", result, err)
		}
		if index == 0 {
			first = result
		}
		if !taskproperties.Equal(first.Tasks[0].Properties, before.Properties) || first.Tasks[0].Version != before.Version {
			t.Fatal("later scope changed an earlier property/version response")
		}
	}
	if f.reads != 3 {
		t.Fatalf("property states used %d snapshots", f.reads)
	}
}

func TestTaskSyncWindowPreservesReturnedRowsAndDecodeErrors(t *testing.T) {
	f := newTaskReadFixture(t)
	epoch := taskReadID(90)
	recent := taskReadView(taskReadID(2), "Inside delta", 1, f.observed)
	invalid := errors.New("decode task property")
	since := recent.UpdatedAt
	sync := f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower == nil {
			return nil, invalid
		}
		want := since.Add(-10 * time.Second)
		if *lower != want {
			t.Fatalf("selected property window=%v want=%v", lower, want)
		}
		return []model.TaskViewRecord{recent}, nil
	}, []model.TaskAssigneeFact{}, 10*time.Second)
	delta, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: epoch, Since: &since})
	if err != nil || !reflect.DeepEqual(delta.Tasks, []model.TaskViewRecord{recent}) || delta.Tasks[0].Properties == nil || len(delta.Tasks[0].Properties) != 0 {
		t.Fatalf("selected properties changed: %#v %v", delta, err)
	}
	snapshot, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
	if !errors.Is(err, invalid) || !reflect.DeepEqual(snapshot, model.TaskSync{}) {
		t.Fatalf("corrupt snapshot leaked partial rows or cause: %#v %v", snapshot, err)
	}
}
