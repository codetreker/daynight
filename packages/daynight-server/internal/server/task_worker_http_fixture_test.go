package server

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
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

func workerHTTPWriteValues(task model.Task) store.TaskWrite {
	return copyTaskHTTPWrite(store.TaskWrite{Title: task.Title, Description: task.Description, Status: task.Status,
		AssignedTo: task.AssignedTo, RequiredPlatform: task.RequiredPlatform, AllowAgents: task.AllowAgents,
		Properties: task.Properties, DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn})
}

type workerHTTPWritePlan struct {
	t                       *testing.T
	TaskDAO                 *taskHTTPWriterMock
	AccessCalls, TaskReads  int
	AccessError             error
	ObservedCalls           int
	access, reads, observed int
	writes, updates, drains int
	receipts, captures      int
	wantUpdate, wantCapture bool
	active                  bool
	ctx                     context.Context
}

func expectWorkerHTTPWrite(t *testing.T, database *httpTestStore, current model.Task, actor model.Principal, role model.ProjectRole, expected *store.TaskWrite, returned model.Task, observedAt *time.Time) *workerHTTPWritePlan {
	t.Helper()
	current, returned = copyTaskHTTPTask(current), copyTaskHTTPTask(returned)
	if expected != nil {
		values := copyTaskHTTPWrite(*expected)
		expected = &values
	}
	observedAt = copyTaskHTTPPointer(observedAt)
	plan := &workerHTTPWritePlan{t: t, AccessCalls: 1, TaskReads: 1, wantUpdate: expected != nil}
	base := newTaskHTTPMockBase(t, "worker HTTP write")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	tasks := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	plan.TaskDAO = tasks
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	checkContext := func(ctx context.Context) {
		if !plan.active || ctx != plan.ctx {
			t.Fatal("Worker DAO escaped its request transaction")
		}
	}
	project.ProjectAccessFn = func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		checkContext(ctx)
		plan.access++
		if principal != actor || plan.access > plan.AccessCalls {
			t.Fatalf("unexpected Worker authorization: %#v", principal)
		}
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: actor.UserID, Role: role}, plan.AccessError
	}
	tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		checkContext(ctx)
		plan.reads++
		if id != current.ID || plan.reads > plan.TaskReads {
			t.Fatalf("unexpected Worker Task lookup: %s", id)
		}
		return copyTaskHTTPTask(current), nil
	}
	if observedAt != nil {
		plan.ObservedCalls = 1
		tasks.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			checkContext(ctx)
			plan.observed++
			if plan.observed != 1 {
				t.Fatal("Worker claim sampled the clock more than once")
			}
			return *observedAt, nil
		}
	}
	if expected != nil {
		tasks.UpdateTaskFn = func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
			checkContext(ctx)
			plan.updates++
			if id != current.ID || plan.updates != 1 || !reflect.DeepEqual(actual, *expected) {
				t.Fatalf("Worker proposed write: got %#v, want %#v", actual, *expected)
			}
			return copyTaskHTTPTask(returned), nil
		}
		wantDrain := store.TaskSessionDrain{SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
			RemoveFields:   []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
			SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		worker, err := taskproperty.Worker(returned.Properties)
		if err != nil {
			t.Fatal(err)
		}
		if returned.Status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
			wantDrain.ActiveClaim = &worker.ClaimID
		}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, actual store.TaskSessionDrain) error {
			checkContext(ctx)
			plan.drains++
			if id != current.ID || plan.drains != 1 || plan.updates != 1 || !reflect.DeepEqual(actual, wantDrain) {
				t.Fatalf("Worker Session drain: %#v", actual)
			}
			return nil
		}
		wantReceipt := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, actual store.TaskSessionReceiptTransition) error {
			checkContext(ctx)
			plan.receipts++
			if id != current.ID || plan.receipts != 1 || plan.drains != 1 || !reflect.DeepEqual(actual, wantReceipt) {
				t.Fatalf("Worker receipt transition: %#v", actual)
			}
			return nil
		}
		if current.Status != returned.Status {
			plan.wantCapture = true
			capture.FreezeAudienceFn = func(ctx context.Context, projectID string, types []string) ([]store.WebhookAudience, error) {
				checkContext(ctx)
				plan.captures++
				if projectID != current.ProjectID || plan.captures != 1 || plan.receipts != 1 || !reflect.DeepEqual(types, []string{protocol.StatusChanged}) {
					t.Fatalf("Worker status capture: %s %v", projectID, types)
				}
				return []store.WebhookAudience{}, nil
			}
		}
	}
	database.WriteProjectCall = func(ctx context.Context, projectID string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.writes++
		if projectID != current.ProjectID || work == nil || plan.writes != 1 || plan.active {
			t.Fatal("Worker action did not use one independent Project transaction")
		}
		plan.ctx, plan.active = ctx, true
		defer func() { plan.active = false }()
		err := work(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	return plan
}

func (plan *workerHTTPWritePlan) check() {
	plan.t.Helper()
	wantWrites, wantCapture := 0, 0
	if plan.wantUpdate {
		wantWrites = 1
	}
	if plan.wantCapture {
		wantCapture = 1
	}
	if plan.writes != 1 || plan.access != plan.AccessCalls || plan.reads != plan.TaskReads || plan.observed != plan.ObservedCalls || plan.updates != wantWrites || plan.drains != wantWrites || plan.receipts != wantWrites || plan.captures != wantCapture {
		plan.t.Fatalf("Worker calls: scope/access/read/clock/update/drain/receipt/capture=%d/%d/%d/%d/%d/%d/%d/%d; want 1/%d/%d/%d/%d/%d/%d/%d", plan.writes, plan.access, plan.reads, plan.observed, plan.updates, plan.drains, plan.receipts, plan.captures, plan.AccessCalls, plan.TaskReads, plan.ObservedCalls, wantWrites, wantWrites, wantWrites, wantCapture)
	}
}
