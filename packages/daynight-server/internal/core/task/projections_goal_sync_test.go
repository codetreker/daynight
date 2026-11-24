package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type goalSyncFixture struct {
	syncProjectionFixture
	prerequisites map[string][]string
	goalErr       error
	goalCalls     int
}

func (f *goalSyncFixture) TaskSyncGoalDependsOn(ctx context.Context, project string, ids []string) (map[string][]string, error) {
	if ctx != f.wantCtx || project != f.wantID || !reflect.DeepEqual(ids, []string{"downstream", "isolated"}) {
		f.t.Fatalf("unexpected Goal prerequisite request: %v %q %v", ctx, project, ids)
	}
	f.goalCalls++
	return f.prerequisites, f.goalErr
}

func TestReadSyncGoalPrerequisites(t *testing.T) {
	ctx := context.Background()
	stamp := time.Date(2026, 11, 23, 0, 0, 0, 0, time.UTC)
	clock := func(context.Context) (time.Time, error) { return stamp, nil }
	for _, mode := range []string{"snapshot", "delta"} {
		t.Run(mode, func(t *testing.T) {
			rows := []model.TaskViewRecord{
				{ID: "ordinary", Type: model.TaskTypeTask, DependsOn: []string{"execution"}, ExternalDependsOn: []string{"execution"}},
				{ID: "downstream", Type: model.TaskTypeGoal, DependsOn: []string{}, ExternalDependsOn: []string{}},
				{ID: "isolated", Type: model.TaskTypeGoal, DependsOn: []string{}, ExternalDependsOn: []string{}},
			}
			states := map[string]model.TaskDependencyState{"ordinary": {TaskVersion: 1, BlockedBy: []string{"execution"}}}
			f := &goalSyncFixture{syncProjectionFixture: syncProjectionFixture{projectionFixture: projectionFixture{epoch: "epoch", records: rows}, t: t, wantCtx: ctx, wantID: "project", states: states}, prerequisites: map[string][]string{"downstream": {"unchanged-prerequisite"}, "isolated": {}}}
			requested := "epoch"
			if mode == "snapshot" {
				requested = "old-epoch"
			}
			result, fault, err := ReadSync(ctx, f, clock, "project", requested, &stamp, time.Second, model.TaskSync{})
			if err != nil || fault != nil || result.Mode != mode || f.goalCalls != 1 || !reflect.DeepEqual(result.Tasks[1].DependsOn, []string{"unchanged-prerequisite"}) || result.Tasks[2].DependsOn == nil || len(result.Tasks[2].DependsOn) != 0 || !reflect.DeepEqual(result.DependencyStates, states) {
				t.Fatalf("Goal sync result=%+v fault=%v err=%v calls=%d", result, fault, err, f.goalCalls)
			}
			if !reflect.DeepEqual(result.Tasks[0].DependsOn, []string{"execution"}) || !reflect.DeepEqual(result.Tasks[0].ExternalDependsOn, []string{"execution"}) || len(result.Tasks[1].ExternalDependsOn) != 0 {
				t.Fatalf("ordinary or external dependency semantics changed: %+v", result.Tasks)
			}
			if !reflect.DeepEqual(f.taskLower, f.stateLower) || mode == "snapshot" && f.taskLower != nil || mode == "delta" && (f.taskLower == nil || !f.taskLower.Equal(stamp.Add(-time.Second))) {
				t.Fatalf("sync windows differ: tasks=%v states=%v", f.taskLower, f.stateLower)
			}
			f.goalErr = errors.New("Goal prerequisite failure")
			result, fault, err = ReadSync(ctx, f, clock, "project", requested, &stamp, time.Second, model.TaskSync{})
			if !errors.Is(err, f.goalErr) || fault != nil || !reflect.DeepEqual(result, model.TaskSync{}) {
				t.Fatalf("partial Goal sync after failure: %+v %v %v", result, fault, err)
			}
		})
	}
}
