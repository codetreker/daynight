package task_test

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type taskReadSessionStates struct {
	t   *testing.T
	ctx context.Context
}

func (r taskReadSessionStates) TaskListSessionStates(ctx context.Context, sources []store.TaskSessionSource) (map[string]model.SessionListState, error) {
	if ctx != r.ctx || sources == nil || len(sources) != 0 {
		r.t.Fatal("empty Session source scope changed")
	}
	return map[string]model.SessionListState{}, nil
}

func (f *taskReadFixture) sync(epoch string, rows func(*time.Time) ([]model.TaskViewRecord, error), people []model.TaskAssigneeFact, overlap time.Duration) *taskservice.TaskSync {
	f.reader.TaskCacheEpochFn = func(ctx context.Context, id string) (string, error) { f.requireProject(ctx, id); return epoch, nil }
	f.reader.TaskSyncTasksFn = nil
	f.reader.TaskAssigneesFn = nil
	f.snapshot.SessionDAOFn = nil
	if rows != nil {
		f.reader.TaskSyncTasksFn = func(ctx context.Context, id string, lower *time.Time, characters int) ([]model.TaskViewRecord, error) {
			f.requireProject(ctx, id)
			if characters != projection.TitlePreviewCharacters {
				f.t.Fatalf("title preview limit changed: %d", characters)
			}
			return rows(lower)
		}
		f.reader.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
			f.requireProject(ctx, id)
			return people, nil
		}
		sessionReader := &sessionReaderMock{taskMockBase: f.base.withLabel("Session reader"), CurrentTaskSessionSourcesFn: func(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
			f.requireProject(ctx, id)
			return []store.TaskSessionSource{}, nil
		}}
		f.snapshot.SessionDAOFn = func() store.SessionReader { f.requireActive(); return sessionReader }
	}
	return taskservice.NewTaskSync(f.store, taskReadSessionStates{t: f.t, ctx: f.ctx}, overlap)
}

func taskReadView(id, title string, version int64, updated time.Time, dependencies ...string) model.TaskViewRecord {
	return model.TaskViewRecord{ID: id, TitlePreview: title, Status: model.TaskTodo, Version: version, Properties: model.TaskProperties{}, DependsOn: append([]string{}, dependencies...), ExternalDependsOn: []string{}, CreatedAt: updated, UpdatedAt: updated}
}

func TestTaskSyncModesWindowAndMutationSignals(t *testing.T) {
	epoch := taskReadID(90)
	stamp := time.Date(2026, 10, 24, 0, 0, 0, 123456000, time.UTC)
	since := stamp.Add(10 * time.Second)
	a := taskReadView(taskReadID(1), "A", 1, stamp.Add(-time.Microsecond))
	b := taskReadView(taskReadID(2), "B", 1, stamp, a.ID)
	b2 := b
	b2.Version++
	a3 := a
	a3.Version = 3
	a3.UpdatedAt = stamp
	future := stamp.Add(time.Hour)
	futureTask := b
	futureTask.UpdatedAt = future
	minus20 := stamp.Add(-20 * time.Second)
	futureLower := future.Add(-10 * time.Second)
	for _, test := range []struct {
		name     string
		input    taskservice.TaskSyncRequest
		overlap  time.Duration
		wantMode string
		lower    *time.Time
		rows     []model.TaskViewRecord
	}{
		{"empty snapshot", taskservice.TaskSyncRequest{}, 10 * time.Second, "snapshot", nil, []model.TaskViewRecord{}},
		{"empty delta", taskservice.TaskSyncRequest{Epoch: epoch}, 10 * time.Second, "delta", nil, []model.TaskViewRecord{}},
		{"inclusive window", taskservice.TaskSyncRequest{Epoch: epoch, Since: &since}, 10 * time.Second, "delta", &stamp, []model.TaskViewRecord{b}},
		{"same stamp higher version", taskservice.TaskSyncRequest{Epoch: epoch, Since: &since}, 10 * time.Second, "delta", &stamp, []model.TaskViewRecord{b2}},
		{"wider overlap", taskservice.TaskSyncRequest{Epoch: epoch, Since: &since}, 30 * time.Second, "delta", &minus20, []model.TaskViewRecord{a, b}},
		{"missing epoch", taskservice.TaskSyncRequest{}, 10 * time.Second, "snapshot", nil, []model.TaskViewRecord{a, b}},
		{"rotated epoch", taskservice.TaskSyncRequest{Epoch: taskReadID(99), Since: &since}, 10 * time.Second, "snapshot", nil, []model.TaskViewRecord{a, b}},
		{"complete delta", taskservice.TaskSyncRequest{Epoch: epoch}, 10 * time.Second, "delta", nil, []model.TaskViewRecord{a, b}},
		{"future row", taskservice.TaskSyncRequest{Epoch: epoch, Since: &future}, 10 * time.Second, "delta", &futureLower, []model.TaskViewRecord{futureTask}},
		{"detail signal", taskservice.TaskSyncRequest{Epoch: epoch, Since: &a3.UpdatedAt}, 10 * time.Second, "delta", pointer(stamp.Add(-10 * time.Second)), []model.TaskViewRecord{a3, b}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newTaskReadFixture(t)
			sync := f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
				if !model.EqualOptional(lower, test.lower) {
					t.Fatalf("lower bound=%v want=%v", lower, test.lower)
				}
				return test.rows, nil
			}, []model.TaskAssigneeFact{}, test.overlap)
			repeats := 1
			if test.name == "inclusive window" {
				repeats = 3
			}
			for range repeats {
				result, err := sync.Get(f.ctx, f.principal, f.project.ID, test.input)
				if err != nil || result.Mode != test.wantMode || result.Epoch != epoch || !reflect.DeepEqual(result.Tasks, test.rows) || result.Project != f.project || result.ObservedAt != f.observed || result.Sessions == nil {
					t.Fatalf("sync window or rows changed: %#v %v", result, err)
				}
				if test.name == "future row" && !result.Tasks[0].UpdatedAt.After(result.ObservedAt) {
					t.Fatal("future row acquired an observedAt upper bound")
				}
			}
			if f.reads != repeats {
				t.Fatalf("snapshot count=%d want=%d", f.reads, repeats)
			}
		})
	}
	for _, overlap := range []time.Duration{time.Nanosecond, 500 * time.Nanosecond, time.Microsecond} {
		f := newTaskReadFixture(t)
		lower := stamp.Add(overlap).Add(time.Nanosecond)
		sync := f.sync(epoch, func(got *time.Time) ([]model.TaskViewRecord, error) {
			want := stamp.Add(time.Nanosecond)
			if got == nil || *got != want {
				t.Fatalf("submicrosecond lower=%v want=%v", got, want)
			}
			return []model.TaskViewRecord{}, nil
		}, []model.TaskAssigneeFact{}, overlap)
		result, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: epoch, Since: &lower})
		if err != nil || result.Mode != "delta" || result.Tasks == nil || len(result.Tasks) != 0 {
			t.Fatalf("submicrosecond overlap %v: %#v %v", overlap, result, err)
		}
	}
	f := newTaskReadFixture(t)
	sync := taskservice.NewTaskSync(f.store, taskReadSessionStates{t: t, ctx: f.ctx}, 10*time.Second)
	for _, test := range []struct {
		principal model.Principal
		projectID string
		input     taskservice.TaskSyncRequest
		code      string
	}{
		{f.principal, f.project.ID, taskservice.TaskSyncRequest{Since: &since}, "invalid_input"},
		{f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: "invalid"}, "invalid_input"},
		{model.Principal{}, f.project.ID, taskservice.TaskSyncRequest{}, "unauthenticated"},
		{f.principal, "invalid", taskservice.TaskSyncRequest{}, "invalid_input"},
	} {
		_, err := sync.Get(f.ctx, test.principal, test.projectID, test.input)
		requireFault(t, err, test.code)
	}
	if f.reads != 0 {
		t.Fatal("invalid Sync input reached storage")
	}
	for _, missingProject := range []bool{false, true} {
		f := newTaskReadFixture(t)
		actor := f.principal
		id := f.project.ID
		if missingProject {
			id = taskReadID(99)
		} else {
			actor.UserID = taskReadID(98)
		}
		f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, projectID string) (model.ProjectAccess, error) {
			f.requireActive()
			if ctx != f.ctx || p != actor || projectID != id {
				t.Fatal("refused access identity changed")
			}
			return model.ProjectAccess{}, model.ErrNotFound
		}
		result, err := taskservice.NewTaskSync(f.store, taskReadSessionStates{t: t, ctx: f.ctx}, 10*time.Second).Get(f.ctx, actor, id, taskservice.TaskSyncRequest{})
		requireFault(t, err, "not_found")
		if !reflect.DeepEqual(result, model.TaskSync{}) {
			t.Fatal("refusal exposed a partial Sync")
		}
	}
}

func TestTaskSyncProjectAccessAndRowsUseOneScope(t *testing.T) {
	f := newTaskReadFixture(t)
	oldEpoch := taskReadID(90)
	before := taskReadView(taskReadID(1), "Before", 1, f.observed)
	dependent := taskReadView(taskReadID(2), "Dependent", 1, f.observed, before.ID)
	oldProject := f.project
	oldAccess := taskMockAccess(f.project, f.principal)
	sync := f.sync(oldEpoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower != nil {
			t.Fatal("complete epoch delta lost all rows")
		}
		return []model.TaskViewRecord{before, dependent}, nil
	}, []model.TaskAssigneeFact{}, 10*time.Second)
	old, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: oldEpoch})
	if err != nil || old.Epoch != oldEpoch || old.Project != oldProject || !reflect.DeepEqual(old.ActorAccess, oldAccess) || len(old.Tasks) != 2 || old.Tasks[0].TitlePreview != "Before" || old.Tasks[0].Version != 1 || !slices.Equal(old.Tasks[1].DependsOn, []string{before.ID}) || f.reads != 1 {
		t.Fatalf("one old scope: %#v %v", old, err)
	}
	f.project.Settings.ExecutionWarningMinutes = 31
	freshAccess := oldAccess
	freshAccess.Role = model.ProjectAdmin
	freshAccess.DirectGrant = &model.ProjectGrant{Version: 9007199254740993}
	f.projectReader.ProjectAccessFn = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		f.requireProject(ctx, id)
		if p != f.principal {
			t.Fatal("fresh scope actor changed")
		}
		return freshAccess, nil
	}
	after := before
	after.TitlePreview = "After"
	after.Status = model.TaskDone
	after.Version++
	sync = f.sync(taskReadID(91), func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower != nil {
			t.Fatal("rotated epoch failed to request full snapshot")
		}
		return []model.TaskViewRecord{after, dependent}, nil
	}, []model.TaskAssigneeFact{}, 10*time.Second)
	fresh, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{Epoch: oldEpoch})
	if err != nil || fresh.Mode != "snapshot" || fresh.Epoch == oldEpoch || fresh.Tasks[0].TitlePreview != "After" || fresh.Project.Settings.ExecutionWarningMinutes != 31 || fresh.ActorAccess.DirectGrant.Version != 9007199254740993 || old.Project != oldProject || old.Tasks[0].TitlePreview != "Before" || f.reads != 2 {
		t.Fatalf("independent fresh scope: %#v %v", fresh, err)
	}
}
