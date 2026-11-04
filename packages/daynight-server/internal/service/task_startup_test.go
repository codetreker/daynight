package service

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/google/uuid"
)

func TestWorkerStartupReportsAreOwnerBoundOrderedAndIdempotent(t *testing.T) {
	tasks, db, project, _, owner := taskService(t)
	ctx := context.Background()
	descriptor := workerDescriptor()
	descriptor.AgentControlMode = core.AgentControlModeWeb
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: uuid.NewString(), ClaimID: descriptor.ClaimID, ExecutionGeneration: "1", ControllerInstanceID: uuid.NewString(), Revision: "2", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode = "unknown", "native_timeout"
	report.Recovery.State, report.Recovery.ReasonCode = "blocked", pointer("native_identity_missing")
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: report.SessionID, ClaimID: report.ClaimID, ExecutionGeneration: "1"}}, Lifecycle: "active", Identity: sp.Identity{ControllerInstanceID: report.ControllerInstanceID, WorkerID: descriptor.WorkerID, WorktreeID: descriptor.WorktreeID}}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, report.SessionID, project.ID, task.ID, report.ClaimID, owner.UserID, uuid.NewString(), raw); err != nil {
		t.Fatal(err)
	}
	write := func(p core.Principal, r sp.StartupReport) (core.Task, error) {
		return tasks.UpdateWorker(ctx, p, project.ID, task.ID, UpdateWorker{Version: task.Version, ClaimID: descriptor.ClaimID, StartupReport: &r})
	}
	task, err = write(owner, report)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := taskproperties.SessionStartup(task.Properties)
	if err != nil || !reflect.DeepEqual(stored, &report) {
		t.Fatalf("stored report: %#v %v", stored, err)
	}
	if replay, err := write(owner, report); err != nil || !reflect.DeepEqual(replay, task) {
		t.Fatalf("replay changed task: %#v %v", replay, err)
	}
	other := workerMember(t, db, project.ID)
	if _, err := write(other, report); err == nil {
		t.Fatal("another member wrote startup evidence")
	} else {
		requireFault(t, err, "forbidden")
	}
	for name, tc := range map[string]struct {
		mutate func(*sp.StartupReport)
		code   string
	}{
		"older revision":            {func(r *sp.StartupReport) { r.Revision = "1" }, "claim_conflict"},
		"revision collision":        {func(r *sp.StartupReport) { r.Startup.ReasonCode = "native_transport_unknown" }, "claim_conflict"},
		"foreign claim":             {func(r *sp.StartupReport) { r.ClaimID = uuid.NewString() }, "claim_conflict"},
		"foreign generation":        {func(r *sp.StartupReport) { r.ExecutionGeneration = "2" }, "claim_conflict"},
		"invalid state combination": {func(r *sp.StartupReport) { r.Startup.State = "failed" }, "invalid_input"},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := report
			tc.mutate(&candidate)
			_, err := write(owner, candidate)
			requireFault(t, err, tc.code)
			assertTaskUnchanged(t, tasks, owner, task)
		})
	}
	report.Revision, report.Startup.State, report.Startup.ReasonCode = "3", "ready", "ready"
	report.Recovery.State, report.Recovery.ReasonCode = "none", nil
	task, err = write(owner, report)
	if err != nil {
		t.Fatal(err)
	}
	stored, err = taskproperties.SessionStartup(task.Properties)
	if err != nil || !reflect.DeepEqual(stored, &report) {
		t.Fatalf("newer evidence missing: %#v %v", stored, err)
	}
	legacy := workerDescriptor()
	legacyTask := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), legacy)
	report.ClaimID = legacy.ClaimID
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, legacyTask.ID, UpdateWorker{Version: legacyTask.Version, ClaimID: legacy.ClaimID, StartupReport: &report})
	requireFault(t, err, "claim_conflict")
	assertTaskUnchanged(t, tasks, owner, legacyTask)
}
