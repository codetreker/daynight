package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type graphFixture struct {
	present   store.TaskPresence
	called    bool
	selection store.TaskGraphSelection
}

type syncProjectionFixture struct {
	projectionFixture
	t          *testing.T
	wantCtx    context.Context
	wantID     string
	states     map[string]model.TaskDependencyState
	stateErr   error
	taskLower  *time.Time
	stateLower *time.Time
	stateCalls int
}

func (f *syncProjectionFixture) TaskSyncTasks(ctx context.Context, id string, lower *time.Time, _ int) ([]model.TaskViewRecord, error) {
	if ctx != f.wantCtx || id != f.wantID {
		f.t.Fatalf("unexpected task request: %v %q", ctx, id)
	}
	f.taskLower = lower
	return f.records, nil
}

func (f *syncProjectionFixture) TaskSyncDependencyStates(ctx context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
	if ctx != f.wantCtx || id != f.wantID {
		f.t.Fatalf("unexpected dependency request: %v %q", ctx, id)
	}
	f.stateCalls++
	f.stateLower = lower
	return f.states, f.stateErr
}

func TestReadSyncDependencyStateWindowAndFailures(t *testing.T) {
	ctx := context.Background()
	stamp := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	lower := stamp.Add(-time.Second)
	states := map[string]model.TaskDependencyState{"task": {TaskVersion: 12, BlockedBy: []string{"prerequisite"}}}
	clock := func(context.Context) (time.Time, error) { return stamp, nil }
	for _, tc := range []struct {
		name, requestedEpoch, mode string
		wantLower                  *time.Time
	}{
		{"snapshot", "old", "snapshot", nil},
		{"delta", "epoch", "delta", &lower},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &syncProjectionFixture{projectionFixture: projectionFixture{epoch: "epoch"}, t: t, wantCtx: ctx, wantID: "project", states: states}
			result, fault, err := ReadSync(ctx, f, clock, "project", tc.requestedEpoch, &stamp, time.Second, model.TaskSync{})
			if err != nil || fault != nil || result.Mode != tc.mode || !reflect.DeepEqual(result.DependencyStates, states) || f.stateCalls != 1 || !reflect.DeepEqual(f.taskLower, tc.wantLower) || !reflect.DeepEqual(f.stateLower, tc.wantLower) {
				t.Fatalf("result=%+v fault=%v err=%v task lower=%v state lower=%v calls=%d", result, fault, err, f.taskLower, f.stateLower, f.stateCalls)
			}
		})
	}
	sentinel := errors.New("dependency read failed")
	f := &syncProjectionFixture{projectionFixture: projectionFixture{epoch: "epoch"}, t: t, wantCtx: ctx, wantID: "project", states: states, stateErr: sentinel}
	result, fault, err := ReadSync(ctx, f, clock, "project", "epoch", &stamp, time.Second, model.TaskSync{})
	if !errors.Is(err, sentinel) || fault != nil || !reflect.DeepEqual(result, model.TaskSync{}) {
		t.Fatalf("partial sync after failure: %+v %v %v", result, fault, err)
	}
}

func (f *graphFixture) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	return f.present, nil
}
func (f *graphFixture) TaskGraphTasks(_ context.Context, _, _ string, selection store.TaskGraphSelection, _ int) ([]model.GraphTask, error) {
	f.selection = selection
	f.called = true
	return []model.GraphTask{{Status: model.TaskTodo, Ready: true}}, nil
}

func TestReadGraphProjectionAndMissingRoot(t *testing.T) {
	ctx := context.Background()
	clock := func(context.Context) (time.Time, error) { return time.Unix(1, 0), nil }
	fixture := &graphFixture{present: store.TaskPresence{Found: true}}
	graph, refusal, err := ReadGraph(ctx, fixture, clock, "project", "task", model.Project{})
	if err != nil || refusal != nil || !fixture.called || graph.Summary.Ready != 1 || !fixture.selection.DirectExternal || !fixture.selection.OrdinaryDependents || !fixture.selection.OrdinaryPrerequisites || !fixture.selection.LiveOnly {
		t.Fatalf("graph: %+v %+v %v", graph, refusal, err)
	}
	fixture.present.Found = false
	_, refusal, err = ReadGraph(ctx, fixture, clock, "project", "task", model.Project{})
	if err != nil || refusal == nil || !errors.Is(refusal, model.ErrNotFound) {
		t.Fatalf("root: %+v %v", refusal, err)
	}
}
