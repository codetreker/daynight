package server

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func workerHTTPTask(t *testing.T) model.Task {
	t.Helper()
	_, current, actor := taskHTTPMockModels()
	current.Title, current.Description = "Interoperable execution", "initial description"
	current.AssignedTo, current.AllowAgents = &actor.UserID, true
	return current
}

func workerHTTPProperties(t *testing.T, before model.TaskProperties, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	result := copyTaskHTTPProperties(before)
	if worker == nil {
		delete(result, "worker")
		delete(result, "sessionStartup")
		return result
	}
	encoded, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	result["worker"] = encoded
	return result
}

func workerHTTPClaimInput(body map[string]any) taskcore.ClaimWorker {
	machine := body["machine"].(map[string]any)
	return taskcore.ClaimWorker{Version: body["version"].(int64), WorkerDescriptor: taskcore.WorkerDescriptor{
		ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string),
		Machine:  model.WorkerMachine{ID: machine["id"].(string), Name: machine["name"].(string)},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr,
		WorktreeID: body["worktreeId"].(string),
	}}
}

type workerHTTPContextKey struct{}

type workerHTTPOperationPlan struct {
	t                 *testing.T
	calls             int
	requestID         string
	marker            any
	actor             model.Principal
	projectID, taskID string
}

func newWorkerHTTPOperationPlan(t *testing.T, actor model.Principal, current model.Task) *workerHTTPOperationPlan {
	t.Helper()
	return &workerHTTPOperationPlan{t: t, actor: actor, projectID: current.ProjectID, taskID: current.ID, requestID: "project-test"}
}

func (p *workerHTTPOperationPlan) require(ctx context.Context, actor model.Principal, projectID, taskID string) {
	p.t.Helper()
	requireOperationHTTPContext(p.t, ctx)
	p.calls++
	if (p.marker != nil && ctx.Value(workerHTTPContextKey{}) != p.marker) || p.calls != 1 || actor != p.actor || projectID != p.projectID || taskID != p.taskID || ctx.Err() != nil || httpx.RequestID(ctx) != p.requestID {
		p.t.Fatalf("Worker operation changed request identity/context/address or count: actor=%#v project=%s task=%s calls=%d request=%q", actor, projectID, taskID, p.calls, httpx.RequestID(ctx))
	}
}

func (p *workerHTTPOperationPlan) check() {
	p.t.Helper()
	if p.calls != 1 {
		p.t.Fatalf("Worker business operation calls=%d, want 1", p.calls)
	}
}

func expectWorkerHTTPClaim(t *testing.T, tasks *taskHTTPOperations, current model.Task, actor model.Principal, expected taskcore.ClaimWorker, result model.Task, failure error) *workerHTTPOperationPlan {
	p := newWorkerHTTPOperationPlan(t, actor, current)
	result = copyTaskHTTPTask(result)
	tasks.ClaimWorkerCall = func(ctx context.Context, principal model.Principal, projectID, taskID string, actual taskcore.ClaimWorker) (model.Task, error) {
		p.require(ctx, principal, projectID, taskID)
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("ClaimWorker input=%#v, want %#v", actual, expected)
		}
		return copyTaskHTTPTask(result), failure
	}
	return p
}

func expectWorkerHTTPUpdate(t *testing.T, tasks *taskHTTPOperations, current model.Task, actor model.Principal, expected taskcore.UpdateWorker, result model.Task, failure error) *workerHTTPOperationPlan {
	p := newWorkerHTTPOperationPlan(t, actor, current)
	result = copyTaskHTTPTask(result)
	expected.Phase = copyTaskHTTPPointer(expected.Phase)
	if expected.Herdr != nil {
		value := copyTaskHTTPPointer(*expected.Herdr)
		expected.Herdr = &value
	}
	if expected.NativeSessionID != nil {
		value := copyTaskHTTPPointer(*expected.NativeSessionID)
		expected.NativeSessionID = &value
	}
	if expected.StartupReport != nil {
		report := *expected.StartupReport
		report.Recovery.ReasonCode = copyTaskHTTPPointer(report.Recovery.ReasonCode)
		expected.StartupReport = &report
	}
	tasks.UpdateWorkerCall = func(ctx context.Context, principal model.Principal, projectID, taskID string, actual taskcore.UpdateWorker) (model.Task, error) {
		p.require(ctx, principal, projectID, taskID)
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("UpdateWorker input=%#v, want %#v", actual, expected)
		}
		return copyTaskHTTPTask(result), failure
	}
	return p
}

func expectWorkerHTTPRelease(t *testing.T, tasks *taskHTTPOperations, current model.Task, actor model.Principal, expected taskcore.ReleaseWorker, result model.Task, failure error) *workerHTTPOperationPlan {
	p := newWorkerHTTPOperationPlan(t, actor, current)
	result = copyTaskHTTPTask(result)
	tasks.ReleaseWorkerCall = func(ctx context.Context, principal model.Principal, projectID, taskID string, actual taskcore.ReleaseWorker) (model.Task, error) {
		p.require(ctx, principal, projectID, taskID)
		if actual != expected {
			t.Fatalf("ReleaseWorker input=%#v, want %#v", actual, expected)
		}
		return copyTaskHTTPTask(result), failure
	}
	return p
}

func expectWorkerHTTPWithdraw(t *testing.T, tasks *taskHTTPOperations, current model.Task, actor model.Principal, expected taskcore.WithdrawWorker, result model.Task, failure error) *workerHTTPOperationPlan {
	p := newWorkerHTTPOperationPlan(t, actor, current)
	result = copyTaskHTTPTask(result)
	tasks.WithdrawWorkerCall = func(ctx context.Context, principal model.Principal, projectID, taskID string, actual taskcore.WithdrawWorker) (model.Task, error) {
		p.require(ctx, principal, projectID, taskID)
		if actual != expected {
			t.Fatalf("WithdrawWorker input=%#v, want %#v", actual, expected)
		}
		return copyTaskHTTPTask(result), failure
	}
	return p
}

func expectWorkerHTTPResume(t *testing.T, tasks *taskHTTPOperations, current model.Task, actor model.Principal, expected taskcore.ResumeWorker, result model.Task, failure error) *workerHTTPOperationPlan {
	p := newWorkerHTTPOperationPlan(t, actor, current)
	result = copyTaskHTTPTask(result)
	tasks.ResumeWorkerCall = func(ctx context.Context, principal model.Principal, projectID, taskID string, actual taskcore.ResumeWorker) (model.Task, error) {
		p.require(ctx, principal, projectID, taskID)
		if !reflect.DeepEqual(actual, expected) {
			t.Fatalf("ResumeWorker input=%#v, want %#v", actual, expected)
		}
		return copyTaskHTTPTask(result), failure
	}
	return p
}

func (f *taskHTTPFixture) expectTaskGet(result model.Task) {
	f.t.Helper()
	plan := newWorkerHTTPOperationPlan(f.t, f.principal, result)
	f.t.Cleanup(plan.check)
	result = copyTaskHTTPTask(result)
	f.tasks.GetCall = func(ctx context.Context, principal model.Principal, projectID, taskID string) (model.Task, error) {
		plan.require(ctx, principal, projectID, taskID)
		return copyTaskHTTPTask(result), nil
	}
}

func assertWorkerHTTPTask(t *testing.T, actual api.Task, expected model.Task) {
	t.Helper()
	expected = copyTaskHTTPTask(expected)
	properties := copyTaskHTTPProperties(expected.Properties)
	if raw, present := properties["worker"]; present {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		delete(fields, "agentControlMode")
		value, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		properties["worker"] = value
	}
	var platform *string
	if expected.RequiredPlatform != nil {
		value := string(*expected.RequiredPlatform)
		platform = &value
	}
	want := api.Task{ID: expected.ID, ProjectID: expected.ProjectID, Title: expected.Title, Description: expected.Description,
		Properties: api.TaskProperties(properties), Status: string(expected.Status), Version: expected.Version,
		CreatedAt: expected.CreatedAt, UpdatedAt: expected.UpdatedAt, StartedAt: expected.StartedAt,
		CompletedAt: expected.CompletedAt, CancelledAt: expected.CancelledAt, DependsOn: expected.DependsOn,
		ExternalDependsOn: expected.ExternalDependsOn, BlockedBy: expected.BlockedBy, RequiredPlatform: platform,
		AssignedTo: expected.AssignedTo, AllowAgents: expected.AllowAgents, Ready: expected.Ready}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("Worker full HTTP Task=%#v, want %#v", actual, want)
	}
}
