package task_test

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type workerCapturerMock struct {
	taskMockBase
	CaptureBatchFn func(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error
}

func (capture *workerCapturerMock) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	capture.need("CaptureBatch", capture.CaptureBatchFn != nil)
	return capture.CaptureBatchFn(ctx, dao, facts)
}

type workerWriteMock struct {
	t                   *testing.T
	Context             context.Context
	Tasks               *taskservice.Tasks
	Store               *taskStoreMock
	Task                *taskWriterMock
	Project             *projectWriterMock
	Session             *projectSessionMock
	Capture             *workerCapturerMock
	CaptureDAO          *captureDAOMock
	ExpectedAccessCalls int
	ExpectedTaskReads   int
	Current             model.Task
}

func workerMockWrite(t *testing.T, current model.Task, principal model.Principal) *workerWriteMock {
	t.Helper()
	base := newTaskMockBase(t, "worker")
	fixture := &workerWriteMock{t: t, Context: t.Context(), Current: current, ExpectedAccessCalls: 1, ExpectedTaskReads: 1}
	fixture.Store = &taskStoreMock{taskMockBase: base.withLabel("store")}
	fixture.Task = &taskWriterMock{taskMockBase: base.withLabel("task")}
	fixture.Project = &projectWriterMock{taskMockBase: base.withLabel("project")}
	fixture.Session = &projectSessionMock{taskMockBase: base.withLabel("session")}
	fixture.Capture = &workerCapturerMock{taskMockBase: base.withLabel("capture")}
	fixture.CaptureDAO = &captureDAOMock{taskMockBase: base.withLabel("captureDAO")}
	scope := &taskProjectScopeMock{taskMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return fixture.Project },
		TaskDAOFn:    func() store.TaskWriteDAO { return fixture.Task },
		SessionDAOFn: func() store.ProjectSessionDAO { return fixture.Session },
		CaptureDAOFn: func() store.WebhookCaptureDAO { return fixture.CaptureDAO },
	}
	reads, writes := 0, 0
	fixture.Project.ProjectAccessFn = func(ctx context.Context, actual model.Principal) (model.ProjectAccess, error) {
		if ctx != fixture.Context || !reflect.DeepEqual(actual, principal) {
			t.Fatal("worker authorization changed context or authenticated principal")
		}
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	fixture.Task.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		reads++
		if ctx != fixture.Context || id != current.ID || reads != 1 {
			t.Fatal("worker operation did not read its current Task once in the authorized scope")
		}
		return current, nil
	}
	fixture.Store.WriteProjectFn = func(ctx context.Context, projectID string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		writes++
		if ctx != fixture.Context || projectID != current.ProjectID || writes != 1 || work == nil {
			t.Fatal("worker operation changed its Project transaction scope")
		}
		if err := work(scope); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		counts := map[string]int{}
		for _, call := range base.trace.snapshot() {
			counts[call]++
		}
		if counts["store.WriteProject"] != 1 || counts["task.Task"] != fixture.ExpectedTaskReads || counts["project.ProjectAccess"] != fixture.ExpectedAccessCalls {
			t.Errorf("worker scope calls: writes=%d reads=%d access=%d, want 1/%d/%d", counts["store.WriteProject"], counts["task.Task"], counts["project.ProjectAccess"], fixture.ExpectedTaskReads, fixture.ExpectedAccessCalls)
		}
	})
	fixture.Tasks = taskservice.NewTasks(fixture.Store, fixture.Capture)
	return fixture
}

func (fixture *workerWriteMock) ExpectUpdate(values store.TaskWrite, returned model.Task) {
	fixture.t.Helper()
	updates, drains, receipts := 0, 0, 0
	fixture.Task.UpdateTaskFn = func(ctx context.Context, id string, actual store.TaskWrite) (model.Task, error) {
		updates++
		if ctx != fixture.Context || id != fixture.Current.ID || updates != 1 || !reflect.DeepEqual(actual, values) {
			fixture.t.Fatalf("worker proposed write: got %#v, want %#v", actual, values)
		}
		return returned, nil
	}
	var activeClaim *string
	worker := testWorker(fixture.t, returned.Properties)
	if returned.Status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
		activeClaim = &worker.ClaimID
	}
	wantDrain := store.TaskSessionDrain{ActiveClaim: activeClaim, SourceLifecycle: "active", GraceSeconds: 60,
		TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
		RemoveFields:   []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
		SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"},
	}
	fixture.Session.DrainTaskSessionsFn = func(ctx context.Context, id string, actual store.TaskSessionDrain) error {
		drains++
		if ctx != fixture.Context || id != fixture.Current.ID || drains != 1 || updates != 1 || !reflect.DeepEqual(actual, wantDrain) {
			fixture.t.Fatalf("worker session drain: %#v", actual)
		}
		return nil
	}
	wantReceipt := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
	fixture.Session.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, actual store.TaskSessionReceiptTransition) error {
		receipts++
		if ctx != fixture.Context || id != fixture.Current.ID || receipts != 1 || drains != 1 || !reflect.DeepEqual(actual, wantReceipt) {
			fixture.t.Fatalf("worker receipt transition: %#v", actual)
		}
		return nil
	}
	fixture.t.Cleanup(func() {
		if updates != 1 || drains != 1 || receipts != 1 {
			fixture.t.Errorf("worker mutation calls: updates=%d drains=%d receipts=%d, want 1/1/1", updates, drains, receipts)
		}
	})
}

func (fixture *workerWriteMock) ExpectCapture(facts []protocol.Fact) {
	fixture.t.Helper()
	calls := 0
	fixture.Capture.CaptureBatchFn = func(ctx context.Context, dao store.WebhookCaptureDAO, actual []protocol.Fact) error {
		calls++
		if ctx != fixture.Context || dao != fixture.CaptureDAO || calls != 1 || !reflect.DeepEqual(actual, facts) {
			fixture.t.Fatalf("worker capture: got %#v, want %#v", actual, facts)
		}
		return nil
	}
	fixture.t.Cleanup(func() {
		if calls != 1 {
			fixture.t.Errorf("worker capture called %d times, want 1", calls)
		}
	})
}

func workerServiceTask(t *testing.T, principal model.Principal) model.Task {
	t.Helper()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	return model.Task{ID: "20000000-0000-4000-8000-000000000003", ProjectID: "20000000-0000-4000-8000-000000000004",
		Title: "Worker task", Description: "Existing Task data", Status: model.TaskTodo, Version: 3,
		CreatedAt: now, UpdatedAt: now, AssignedTo: &principal.UserID, AllowAgents: true, Ready: true,
		Properties: model.TaskProperties{}, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{},
	}
}

func workerServicePrincipal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: "20000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000002"}
}

func TestWorkerClaimRequiresAuthenticatedAssignee(t *testing.T) {
	admin := workerServicePrincipal()
	owner, other := admin, admin
	owner.UserID, other.UserID = "20000000-0000-4000-8000-000000000005", "20000000-0000-4000-8000-000000000006"
	for _, claimant := range []model.Principal{owner, admin} {
		for _, assigned := range []*string{nil, &other.UserID, &claimant.UserID} {
			name := "unassigned"
			if assigned != nil {
				name = *assigned
			}
			t.Run(claimant.UserID+"/"+name, func(t *testing.T) {
				before := workerServiceTask(t, claimant)
				before.AssignedTo = assigned
				fixture := workerMockWrite(t, before, claimant)
				descriptor := workerDescriptor()
				claimedAt := before.UpdatedAt.Add(time.Second)
				if assigned != nil && *assigned == claimant.UserID {
					worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, WorkerID: descriptor.WorkerID, UserID: claimant.UserID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: descriptor.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
					values := taskcore.CurrentWrite(before)
					values.Status, values.Properties = model.TaskInProgress, testWithWorker(t, before.Properties, worker)
					returned := before
					returned.Status, returned.Properties, returned.Ready, returned.Version = values.Status, values.Properties, false, before.Version+1
					returned.StartedAt, returned.UpdatedAt = &claimedAt, claimedAt
					fixture.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
						if ctx != fixture.Context {
							t.Fatal("worker clock changed context")
						}
						return claimedAt, nil
					}
					fixture.ExpectUpdate(values, returned)
					fixture.ExpectCapture([]protocol.Fact{{Type: protocol.StatusChanged, ProjectID: before.ProjectID, TaskID: before.ID, TaskVersion: returned.Version, OccurredAt: claimedAt, PreviousStatus: string(before.Status), Status: string(returned.Status)}})
				}
				after, err := fixture.Tasks.ClaimWorker(fixture.Context, claimant, before.ProjectID, before.ID, taskcore.ClaimWorker{Version: before.Version, WorkerDescriptor: descriptor})
				if assigned == nil || *assigned != claimant.UserID {
					requireFault(t, err, "invalid_transition")
					if !reflect.DeepEqual(after, model.Task{}) {
						t.Fatal("refused claim exposed a Task")
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				worker := testWorker(t, after.Properties)
				if after.Status != model.TaskInProgress || !model.EqualOptional(after.AssignedTo, assigned) || worker.UserID != claimant.UserID || worker.WorkerID != descriptor.WorkerID {
					t.Fatalf("claim did not bind the authenticated assignee: %#v", after)
				}
			})
		}
	}
}
