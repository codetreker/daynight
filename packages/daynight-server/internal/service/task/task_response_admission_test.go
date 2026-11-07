package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestTaskResponseAdmissionRollsBackActualWrites(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	prerequisite := createTask(t, tasks, principal, project.ID, "Prerequisite")
	target := createTask(t, tasks, principal, project.ID, "Original")
	// An oversized MCP envelope exercises a controlled output failure after the
	// real DAO write, without manufacturing an invalid Task candidate.
	oversized := taskservice.WithMCPTaskResponse(ctx, strings.Repeat("r", taskcore.MaxTaskResponseJSONBytes), int64(1), false, false, true)
	assertLimit := func(err error) {
		t.Helper()
		fault, ok := operation.KnownFault(err)
		var violation *limit.Violation
		facts := operation.CompletionFacts(err)
		if !ok || fault.Code != "resource_limit_exceeded" || !errors.As(err, &violation) || facts.Outcome != store.TransactionNotCommitted || facts.CleanupFailed {
			t.Fatalf("expected confirmed rollback with response limit, got %v (%+v)", err, facts)
		}
	}
	_, err := tasks.Update(oversized, principal, project.ID, target.ID, taskcore.UpdateTask{
		Version: target.Version, Title: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}),
		Properties: propertyPatch(model.PullRequestProperty{URL: "value", Title: "title"}),
	})
	assertLimit(err)
	assertTaskUnchanged(t, tasks, principal, target)
	_, err = tasks.Create(oversized, principal, project.ID, taskcore.CreateTask{Title: "Rejected", DependsOn: []string{prerequisite.ID}})
	assertLimit(err)
	page, err := tasks.List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}})
	if err != nil || len(page.Items) != 2 {
		t.Fatalf("failed create left a Task: %+v, %v", page, err)
	}
	updated, err := tasks.Update(taskservice.WithMCPTaskResponse(ctx, "request", int64(1), false, false, true), principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed")})
	if err != nil || updated.Version != target.Version+1 || updated.Title != "Changed" {
		t.Fatalf("ordinary MCP response rejected: %+v, %v", updated, err)
	}
	unchanged, err := tasks.Update(taskservice.WithMCPTaskResponse(ctx, "request", int64(1), false, false, true), principal, project.ID, updated.ID, taskcore.UpdateTask{Version: updated.Version, Title: pointer(updated.Title)})
	if err != nil || !reflect.DeepEqual(updated, unchanged) {
		t.Fatalf("no-op changed Task: %+v, %v", unchanged, err)
	}
}

func TestWorkerLimitsRejectClaimAndStartupWithoutPartialChanges(t *testing.T) {
	tasks, db, project, _, owner := taskService(t)
	ctx := context.Background()
	target := claimableTask(t, tasks, owner, project.ID)
	descriptor := workerDescriptor()
	descriptor.AgentControlMode = model.AgentControlModeWeb
	descriptor.Machine.Name = strings.Repeat("m", taskproperties.MaxWorkerMachineNameBytes+1)
	_, err := tasks.ClaimWorker(ctx, owner, project.ID, target.ID, taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: descriptor})
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, owner, target)
	descriptor.Machine.Name = strings.Repeat("m", taskproperties.MaxWorkerMachineNameBytes)
	claimed := claimWorkerTask(t, tasks, owner, target, descriptor)
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: uuid.NewString(), ClaimID: descriptor.ClaimID, ExecutionGeneration: "1", ControllerInstanceID: uuid.NewString(), Revision: "2", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode = "ready", "ready"
	report.Recovery.State = "none"
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: report.SessionID, ClaimID: report.ClaimID, ExecutionGeneration: "1"}}, Lifecycle: "active", Identity: sp.Identity{ControllerInstanceID: report.ControllerInstanceID, WorkerID: descriptor.WorkerID, WorktreeID: descriptor.WorktreeID}}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, report.SessionID, project.ID, claimed.ID, report.ClaimID, owner.UserID, uuid.NewString(), raw); err != nil {
		t.Fatal(err)
	}
	native := strings.Repeat("n", taskproperties.MaxWorkerNativeSessionIDBytes+1)
	input := taskcore.UpdateWorker{Version: claimed.Version, ClaimID: descriptor.ClaimID, NativeSessionID: pointer(&native), StartupReport: &report}
	_, err = tasks.UpdateWorker(ctx, owner, project.ID, claimed.ID, input)
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, owner, claimed)
	native = strings.Repeat("n", taskproperties.MaxWorkerNativeSessionIDBytes)
	input.NativeSessionID = pointer(&native)
	updated, err := tasks.UpdateWorker(ctx, owner, project.ID, claimed.ID, input)
	if err != nil || updated.Version != claimed.Version+1 {
		t.Fatalf("valid worker and startup rejected: %+v, %v", updated, err)
	}
	stored, err := taskproperties.SessionStartup(updated.Properties)
	if err != nil || !reflect.DeepEqual(stored, &report) || *testWorker(t, updated.Properties).NativeSessionID != native {
		t.Fatalf("worker or startup not retained: %+v, %v", stored, err)
	}
}

func TestPartitionAndPropertyAdmissionPreservesVersionPrecedence(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	target := createTask(t, tasks, principal, project.ID, "Original")
	deps := make([]string, taskcore.MaxDependencies+1)
	for i := range deps {
		deps[i] = "invalid"
	}
	_, err := tasks.UpdatePartitionedDependencies(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version + 1}, &deps, nil)
	requireFault(t, err, "version_conflict")
	_, err = tasks.UpdatePartitionedDependencies(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version}, &deps, nil)
	requireFault(t, err, "invalid_input")
	value := `[{"url":"` + strings.Repeat("x", 2049) + `","title":""}]`
	_, err = tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", value, target.Version+1)
	requireFault(t, err, "version_conflict")
	_, err = tasks.SetProperty(ctx, principal, project.ID, target.ID, "pullRequests", value, target.Version)
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, principal, target)
}
