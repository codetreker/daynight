package task_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestWorkerStartupReportsAreOwnerBoundOrderedAndIdempotent(t *testing.T) {
	owner := workerServicePrincipal()
	descriptor := workerDescriptor()
	descriptor.AgentControlMode = model.AgentControlModeWeb
	initial := workerProtocolTask(t, owner, descriptor, model.WorkerActive)
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: "23000000-0000-4000-8000-000000000001", ClaimID: descriptor.ClaimID, ExecutionGeneration: "1", ControllerInstanceID: "23000000-0000-4000-8000-000000000002", Revision: "2", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode = "unknown", "native_timeout"
	report.Recovery.State, report.Recovery.ReasonCode = "blocked", pointer("native_identity_missing")
	withReport := func(t *testing.T, current model.Task, report sp.StartupReport) model.Task {
		t.Helper()
		current.Properties = taskproperties.Clone(current.Properties)
		normalized, err := taskproperties.NormalizeValue("sessionStartup", propertyJSON(report))
		if err != nil {
			t.Fatal(err)
		}
		current.Properties["sessionStartup"] = normalized
		return current
	}
	stored := withReport(t, initial, report)
	stored.Version, stored.UpdatedAt = initial.Version+1, initial.UpdatedAt.Add(time.Second)
	match := func(t *testing.T, f *workerWriteMock, current model.Task, expected sp.StartupReport, result bool) {
		t.Helper()
		calls := 0
		f.Session.MatchSessionStartupFn = func(ctx context.Context, id string, worker *model.WorkerClaim, actual sp.StartupReport) (bool, error) {
			calls++
			if ctx != f.Context || id != current.ID || calls != 1 || !reflect.DeepEqual(worker, testWorker(t, current.Properties)) || !reflect.DeepEqual(actual, expected) {
				t.Fatalf("startup session matcher changed binding: %#v %#v", worker, actual)
			}
			return result, nil
		}
		t.Cleanup(func() {
			if calls != 1 {
				t.Errorf("startup session matched %d times, want 1", calls)
			}
		})
	}
	t.Run("initial report", func(t *testing.T) {
		f := workerMockWrite(t, initial, owner)
		match(t, f, initial, report, true)
		values := taskcore.CurrentWrite(initial)
		values.Properties = stored.Properties
		f.ExpectUpdate(values, stored)
		after, err := f.Tasks.UpdateWorker(f.Context, owner, initial.ProjectID, initial.ID, taskcore.UpdateWorker{Version: initial.Version, ClaimID: descriptor.ClaimID, StartupReport: &report})
		actual, decodeErr := taskproperties.SessionStartup(after.Properties)
		if err != nil || decodeErr != nil || !reflect.DeepEqual(actual, &report) || !reflect.DeepEqual(after, stored) {
			t.Fatalf("stored report: %#v %v %v", actual, err, decodeErr)
		}
	})
	t.Run("replay", func(t *testing.T) {
		f := workerMockWrite(t, stored, owner)
		match(t, f, stored, report, true)
		after, err := f.Tasks.UpdateWorker(f.Context, owner, stored.ProjectID, stored.ID, taskcore.UpdateWorker{Version: stored.Version, ClaimID: descriptor.ClaimID, StartupReport: &report})
		if err != nil || !reflect.DeepEqual(after, stored) {
			t.Fatalf("startup replay changed Task: %#v %v", after, err)
		}
	})
	t.Run("other owner", func(t *testing.T) {
		other := owner
		other.UserID = "23000000-0000-4000-8000-000000000003"
		f := workerMockWrite(t, stored, other)
		after, err := f.Tasks.UpdateWorker(f.Context, other, stored.ProjectID, stored.ID, taskcore.UpdateWorker{Version: stored.Version, ClaimID: descriptor.ClaimID, StartupReport: &report})
		requireFault(t, err, "forbidden")
		if !reflect.DeepEqual(after, model.Task{}) {
			t.Fatal("nonowner report exposed a Task")
		}
	})
	for _, tc := range []struct {
		name    string
		mutate  func(*sp.StartupReport)
		code    string
		matcher bool
		matched bool
	}{
		{"older revision", func(r *sp.StartupReport) { r.Revision = "1" }, "claim_conflict", true, true},
		{"revision collision", func(r *sp.StartupReport) { r.Startup.ReasonCode = "native_transport_unknown" }, "claim_conflict", true, true},
		{"foreign claim", func(r *sp.StartupReport) { r.ClaimID = "23000000-0000-4000-8000-000000000004" }, "claim_conflict", false, false},
		{"foreign generation", func(r *sp.StartupReport) { r.ExecutionGeneration = "2" }, "claim_conflict", true, false},
		{"invalid state combination", func(r *sp.StartupReport) { r.Startup.State = "failed" }, "invalid_input", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := report
			tc.mutate(&candidate)
			if tc.code == "invalid_input" {
				tasks := taskservice.NewTasks(&taskStoreMock{taskMockBase: newTaskMockBase(t, "startup preflight")})
				_, err := tasks.UpdateWorker(t.Context(), owner, stored.ProjectID, stored.ID, taskcore.UpdateWorker{Version: stored.Version, ClaimID: descriptor.ClaimID, StartupReport: &candidate})
				requireFault(t, err, tc.code)
				return
			}
			f := workerMockWrite(t, stored, owner)
			if tc.matcher {
				match(t, f, stored, candidate, tc.matched)
			}
			after, err := f.Tasks.UpdateWorker(f.Context, owner, stored.ProjectID, stored.ID, taskcore.UpdateWorker{Version: stored.Version, ClaimID: descriptor.ClaimID, StartupReport: &candidate})
			requireFault(t, err, tc.code)
			if !reflect.DeepEqual(after, model.Task{}) {
				t.Fatal("refused startup update exposed a Task")
			}
		})
	}
	t.Run("newer report", func(t *testing.T) {
		newer := report
		newer.Revision, newer.Startup.State, newer.Startup.ReasonCode = "3", "ready", "ready"
		newer.Recovery.State, newer.Recovery.ReasonCode = "none", nil
		returned := withReport(t, stored, newer)
		returned.Version, returned.UpdatedAt = stored.Version+1, stored.UpdatedAt.Add(time.Second)
		f := workerMockWrite(t, stored, owner)
		match(t, f, stored, newer, true)
		values := taskcore.CurrentWrite(stored)
		values.Properties = returned.Properties
		f.ExpectUpdate(values, returned)
		after, err := f.Tasks.UpdateWorker(f.Context, owner, stored.ProjectID, stored.ID, taskcore.UpdateWorker{Version: stored.Version, ClaimID: descriptor.ClaimID, StartupReport: &newer})
		actual, decodeErr := taskproperties.SessionStartup(after.Properties)
		if err != nil || decodeErr != nil || !reflect.DeepEqual(actual, &newer) || !reflect.DeepEqual(after, returned) {
			t.Fatalf("newer startup evidence: %#v %v %v", actual, err, decodeErr)
		}
	})
	t.Run("legacy execution", func(t *testing.T) {
		legacy := descriptor
		legacy.AgentControlMode = model.AgentControlModeHerdr
		current := workerProtocolTask(t, owner, legacy, model.WorkerActive)
		f := workerMockWrite(t, current, owner)
		after, err := f.Tasks.UpdateWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.UpdateWorker{Version: current.Version, ClaimID: legacy.ClaimID, StartupReport: &report})
		requireFault(t, err, "claim_conflict")
		if !reflect.DeepEqual(after, model.Task{}) {
			t.Fatal("legacy execution accepted startup evidence")
		}
	})
}
