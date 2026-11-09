package task_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type taskDeletionCapture func(context.Context, store.WebhookCaptureDAO, []protocol.Fact) error

func (capture taskDeletionCapture) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	return capture(ctx, dao, facts)
}

func taskDeletionWorker(t *testing.T, state model.WorkerState) model.TaskProperties {
	t.Helper()
	_, target, principal := taskMockModels()
	descriptor := workerDescriptor()
	return testWithWorker(t, target.Properties, &model.WorkerClaim{ClaimID: descriptor.ClaimID, State: state, UserID: principal.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: descriptor.WorktreeID, Phase: model.WorkerPreparing, ClaimedAt: target.CreatedAt})
}

func taskDeletionService(t *testing.T, f *taskFailureFixture, target model.Task, expectedCaptures int) *taskservice.Tasks {
	t.Helper()
	f.scope.SessionDAOFn = func() store.ProjectSessionDAO { return f.sessions }
	f.sessions.DrainTaskSessionsFn = func(actual context.Context, id string, drain store.TaskSessionDrain) error {
		if actual != f.ctx || id != target.ID || drain.ActiveClaim != nil || drain.SourceLifecycle != "active" || drain.GraceSeconds != 60 {
			t.Fatalf("wrong deletion drain: %#v", drain)
		}
		return nil
	}
	f.sessions.TransitionTaskSessionReceiptsFn = func(actual context.Context, id string, transition store.TaskSessionReceiptTransition) error {
		if actual != f.ctx || id != target.ID || transition.Lifecycle != "draining" || transition.PreviousState != "accepted" || transition.NextState != "rejected" {
			t.Fatalf("wrong deletion receipts: %#v", transition)
		}
		return nil
	}
	f.projects.InvalidateTaskCacheFn = func(actual context.Context) error {
		if actual != f.ctx {
			t.Fatal("epoch invalidation changed context")
		}
		return nil
	}
	captureDAO := &captureDAOMock{taskMockBase: f.database.taskMockBase.withLabel("capture")}
	f.scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return captureDAO }
	captureCalls := 0
	capture := taskDeletionCapture(func(actual context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
		captureCalls++
		if captureCalls > 1 {
			t.Fatal("unexpected additional deletion capture")
		}
		if actual != f.ctx || dao != captureDAO || len(facts) != 1 || facts[0].Type != protocol.Deleted || facts[0].ProjectID != target.ProjectID || facts[0].TaskID != target.ID || facts[0].TaskVersion != target.Version+1 || !facts[0].OccurredAt.Equal(target.UpdatedAt.Add(time.Second)) || facts[0].DeletedAt == nil || !facts[0].DeletedAt.Equal(facts[0].OccurredAt) {
			t.Fatalf("wrong deletion capture: %#v", facts)
		}
		return nil
	})
	t.Cleanup(func() {
		if captureCalls != expectedCaptures {
			t.Fatalf("deletion capture calls: %d, want %d", captureCalls, expectedCaptures)
		}
	})
	return taskservice.NewTasks(f.database, capture)
}

func expectTaskDeletion(t *testing.T, f *taskFailureFixture, target model.Task, removeDepends bool) {
	t.Helper()
	called := false
	f.tasks.DeleteTaskFn = func(actual context.Context, id string, remove bool) (model.TaskTombstone, error) {
		if called {
			t.Fatal("unexpected additional Task deletion")
		}
		called = true
		if actual != f.ctx || id != target.ID || remove != removeDepends {
			t.Fatal("wrong Task deletion arguments")
		}
		return model.TaskTombstone{ID: target.ID, ProjectID: target.ProjectID, Version: target.Version + 1, DeletedAt: target.UpdatedAt.Add(time.Second)}, nil
	}
}

func TestTaskDeletionProtectsVersionDependenciesAndWorker(t *testing.T) {
	for _, scenario := range []string{"stale", "dependents", "active-worker"} {
		t.Run(scenario, func(t *testing.T) {
			f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
			target := f.target
			version := target.Version
			code := ""
			dependents := []string{"66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"}
			switch scenario {
			case "stale":
				version++
				code = "version_conflict"
			case "dependents":
				target.Status = model.TaskDone
				code = "dependency_unsatisfied"
				f.tasks.DependentIDsFn = func(context.Context, string) ([]string, error) { return dependents, nil }
			case "active-worker":
				target.Status = model.TaskInProgress
				target.Properties = taskDeletionWorker(t, model.WorkerActive)
				code = "invalid_transition"
			}
			f.expectTask(t, target)
			err := taskservice.NewTasks(f.database).Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: version})
			fault := requireFault(t, err, code)
			if scenario == "dependents" && !slices.Equal(fault.TaskIDs, dependents) {
				t.Fatalf("missing dependent IDs: %#v", fault)
			}
			if f.callbackError != nil {
				t.Fatalf("business refusal escaped callback: %v", f.callbackError)
			}
		})
	}
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		t.Run(string(status), func(t *testing.T) {
			f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
			target := f.target
			target.Status = status
			f.expectTask(t, target)
			f.tasks.DependentIDsFn = func(context.Context, string) ([]string, error) { return []string{}, nil }
			expectTaskDeletion(t, f, target, false)
			if err := taskDeletionService(t, f, target, 1).Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: target.Version}); err != nil {
				t.Fatal(err)
			}
		})
	}
	t.Run("released-worker", func(t *testing.T) {
		f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
		target := f.target
		target.Status = model.TaskInProgress
		target.Properties = taskDeletionWorker(t, model.WorkerReleased)
		f.expectTask(t, target)
		f.tasks.DependentIDsFn = func(context.Context, string) ([]string, error) { return []string{}, nil }
		expectTaskDeletion(t, f, target, false)
		if err := taskDeletionService(t, f, target, 1).Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: target.Version}); err != nil {
			t.Fatal(err)
		}
	})
}

func TestTaskDeletionValidationAndAccessDoNotExposeHistory(t *testing.T) {
	project, target, principal := taskMockModels()
	database := &taskStoreMock{taskMockBase: newTaskMockBase(t, "store")}
	tasks := taskservice.NewTasks(database)
	for _, request := range []struct {
		actor         model.Principal
		projectID, id string
		version       int64
		code          string
	}{
		{model.Principal{}, project.ID, target.ID, target.Version, "unauthenticated"},
		{principal, "invalid", target.ID, target.Version, "invalid_input"},
		{principal, project.ID, "invalid", target.Version, "invalid_input"},
		{principal, project.ID, target.ID, 0, "invalid_input"},
	} {
		requireFault(t, tasks.Delete(t.Context(), request.actor, request.projectID, request.id, taskcore.DeleteTask{Version: request.version}), request.code)
	}
	if len(database.trace.snapshot()) != 0 {
		t.Fatal("invalid deletion entered storage")
	}
	t.Run("inaccessible-project", func(t *testing.T) {
		f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
		stranger := principal
		stranger.UserID = "99999999-9999-4999-8999-999999999999"
		f.projects.ProjectAccessFn = func(actual context.Context, actor model.Principal) (model.ProjectAccess, error) {
			if actual != f.ctx || actor != stranger {
				t.Fatal("wrong inaccessible principal")
			}
			return model.ProjectAccess{}, model.ErrNotFound
		}
		requireFault(t, taskservice.NewTasks(f.database).Delete(f.ctx, stranger, project.ID, target.ID, taskcore.DeleteTask{Version: target.Version}), "not_found")
		if f.callbackError != nil {
			t.Fatal("inaccessible project refusal escaped callback")
		}
	})
	t.Run("missing-task", func(t *testing.T) {
		f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
		f.tasks.TaskFn = func(context.Context, string) (model.Task, error) { return model.Task{}, model.ErrNotFound }
		requireFault(t, taskservice.NewTasks(f.database).Delete(f.ctx, principal, project.ID, target.ID, taskcore.DeleteTask{Version: target.Version}), "not_found")
	})
}

func TestTaskDeletionEpochFailurePreservesCause(t *testing.T) {
	f := newTaskFailureFixture(t, t.Context(), store.TransactionNotCommitted)
	target := f.target
	f.expectTask(t, target)
	f.tasks.DependentIDsFn = func(context.Context, string) ([]string, error) { return []string{}, nil }
	expectTaskDeletion(t, f, target, false)
	tasks := taskDeletionService(t, f, target, 0)
	cause := errors.New("epoch rotation failed")
	f.projects.InvalidateTaskCacheFn = func(context.Context) error { return cause }
	err := tasks.Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: target.Version})
	assertOperational(t, err)
	if !errors.Is(err, cause) || f.callbackError != cause {
		t.Fatalf("lost epoch failure: %v", err)
	}
	if calls := f.database.trace.snapshot(); slices.Contains(calls, "scope.CaptureDAO") {
		t.Fatalf("capture followed failed epoch invalidation: %v", calls)
	}
}

func TestTaskDeletionPreservesCompletedWorkerHistory(t *testing.T) {
	f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
	target := f.target
	target.Status = model.TaskDone
	target.Properties = taskDeletionWorker(t, model.WorkerCompleted)
	before := testWithWorker(t, target.Properties, testWorker(t, target.Properties))
	f.expectTask(t, target)
	f.tasks.DependentIDsFn = func(context.Context, string) ([]string, error) { return []string{}, nil }
	expectTaskDeletion(t, f, target, false)
	if err := taskDeletionService(t, f, target, 1).Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: target.Version}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(target.Properties, before) {
		t.Fatal("deletion modified completed worker properties")
	}
}

func TestTaskDeletionCoordinatesSessionFreezeAndEpoch(t *testing.T) {
	for _, failure := range []string{"session", "epoch", "none"} {
		t.Run(failure, func(t *testing.T) {
			completion := store.TransactionCommitted
			if failure != "none" {
				completion = store.TransactionNotCommitted
			}
			f := newTaskFailureFixture(t, t.Context(), completion)
			target := f.target
			f.expectTask(t, target)
			f.tasks.DependentIDsFn = func(actual context.Context, id string) ([]string, error) {
				if actual != f.ctx || id != target.ID {
					t.Fatal("deletion dependency scope changed")
				}
				return []string{}, nil
			}
			expectTaskDeletion(t, f, target, false)
			captures := 0
			if failure == "none" {
				captures = 1
			}
			tasks := taskDeletionService(t, f, target, captures)
			cause := errors.New(failure + " failed")
			if failure == "session" {
				drain := f.sessions.DrainTaskSessionsFn
				f.sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, plan store.TaskSessionDrain) error {
					if err := drain(ctx, id, plan); err != nil {
						return err
					}
					return cause
				}
			}
			if failure == "epoch" {
				invalidate := f.projects.InvalidateTaskCacheFn
				f.projects.InvalidateTaskCacheFn = func(ctx context.Context) error {
					if err := invalidate(ctx); err != nil {
						return err
					}
					return cause
				}
			}
			err := tasks.Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: target.Version})
			if failure == "none" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, cause) || f.callbackError != cause {
				t.Fatalf("deletion lost coordination failure: %v", err)
			}
			calls := f.database.trace.snapshot()
			for _, method := range []string{"tasks.DeleteTask", "sessions.DrainTaskSessions", "sessions.TransitionTaskSessionReceipts", "projects.InvalidateTaskCache"} {
				want := 1
				if failure == "session" && (method == "sessions.TransitionTaskSessionReceipts" || method == "projects.InvalidateTaskCache") {
					want = 0
				}
				if actual := countTaskCoordinationCall(calls, method); actual != want {
					t.Fatalf("%s calls=%d want=%d in %v", method, actual, want, calls)
				}
			}
		})
	}
}

func countTaskCoordinationCall(calls []string, method string) int {
	count := 0
	for _, call := range calls {
		if call == method {
			count++
		}
	}
	return count
}
