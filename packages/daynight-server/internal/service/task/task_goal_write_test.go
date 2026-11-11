package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestGoalCreateDecoratesBeforeCommitAndDefaultsOwner(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "default owner", true: "explicit null"}[explicit], func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			f.projectWriter.ProjectAccessFn = func(_ context.Context, actor model.Principal) (model.ProjectAccess, error) {
				if actor.UserID != f.principal.UserID {
					t.Fatal("wrong assignee")
				}
				return taskMockAccess(f.project, f.principal), nil
			}
			now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
			wrote, queried, committed := false, false, false
			f.database.WriteProjectFn = func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				if actual != ctx || id != f.project.ID {
					t.Fatal("wrong scope")
				}
				err := work(f.scope)
				if err == nil {
					committed = true
				}
				return store.Completion{Outcome: store.TransactionCommitted}, err
			}
			f.writer.ObservedAtFn = func(context.Context) (time.Time, error) { return now, nil }
			f.writer.CreateTaskFn = func(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
				if values.Type != model.TaskTypeGoal || values.Status != model.TaskTodo || (values.AssignedTo == nil) != explicit {
					t.Fatalf("candidate: %+v", values)
				}
				if !explicit && *values.AssignedTo != f.principal.UserID {
					t.Fatal("wrong default owner")
				}
				wrote = true
				result := ruleTask(id, "Goal")
				result.Type = model.TaskTypeGoal
				result.Status = model.TaskTodo
				result.Ready = false
				result.AssignedTo = values.AssignedTo
				return result, nil
			}
			f.writer.GoalProgressesFn = func(_ context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
				if !wrote || committed || project != f.project.ID || len(ids) != 1 {
					t.Fatal("progress did not run after write and before commit")
				}
				queried = true
				return map[string]model.GoalProgress{ids[0]: {Total: 2, Done: 1, Unfinished: 1}}, nil
			}
			got, err := f.tasks.Create(ctx, f.principal, f.project.ID, taskcore.CreateTask{Type: model.TaskTypeGoal, Title: "Goal", AssignedToPresent: explicit})
			if err != nil || !committed || !queried || got.Progress == nil || *got.Progress != (model.GoalProgress{Total: 2, Done: 1, Unfinished: 1}) {
				t.Fatalf("result %+v %v", got, err)
			}
		})
	}
}

func TestGoalWriteProgressFailureAbortsCommit(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.Type = model.TaskTypeGoal
	current.Ready = false
	f.current(ctx, current)
	progressErr := errors.New("aggregate failure")
	f.writer.GoalProgressesFn = func(context.Context, string, []string) (map[string]model.GoalProgress, error) {
		return nil, progressErr
	}
	var callbackErr error
	f.database.WriteProjectFn = func(_ context.Context, _ string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		callbackErr = work(f.scope)
		return store.Completion{Outcome: store.TransactionNotCommitted}, callbackErr
	}
	title := current.Title
	got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version, Title: &title})
	if !errors.Is(err, progressErr) || !errors.Is(callbackErr, progressErr) || !reflect.DeepEqual(got, model.Task{}) {
		t.Fatalf("progress failure: %+v %v %v", got, err, callbackErr)
	}
}

func TestDeletedParentRefusesChildWritesBeforeMutation(t *testing.T) {
	for _, operation := range []string{"update", "detach", "status", "property", "delete", "claim"} {
		t.Run(operation, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.writer.TaskFn = func(context.Context, string) (model.Task, error) { return model.Task{}, model.ErrTaskDeleted }
			var err error
			switch operation {
			case "update":
				title := "Changed"
				_, err = f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, Title: &title})
			case "detach":
				var none *string
				_, err = f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, ParentID: &none})
			case "status":
				_, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: model.TaskDone})
			case "property":
				_, err = f.tasks.SetProperty(ctx, f.principal, f.project.ID, f.target.ID, "paused", "true", f.target.Version)
			case "claim":
				_, err = f.tasks.ClaimWorker(ctx, f.principal, f.project.ID, f.target.ID, taskcore.ClaimWorker{Version: f.target.Version, WorkerDescriptor: workerDescriptor()})
			case "delete":
				err = f.tasks.Delete(ctx, f.principal, f.project.ID, f.target.ID, taskcore.DeleteTask{Version: f.target.Version})
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "task_deleted" {
				t.Fatalf("%s: %v", operation, err)
			}
		})
	}
}

func TestGoalDeleteInvalidatesEpochWithoutChildOrExecutionEffects(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.Type = model.TaskTypeGoal
	current.Ready = false
	f.current(ctx, current)
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	deleted, invalidated := false, false
	f.writer.DeleteTaskFn = func(_ context.Context, id string, remove bool) (model.TaskTombstone, error) {
		if id != current.ID || remove {
			t.Fatal("wrong Goal deletion")
		}
		deleted = true
		return model.TaskTombstone{ID: id, ProjectID: current.ProjectID, Version: current.Version + 1, DeletedAt: current.UpdatedAt}, nil
	}
	f.projectWriter.InvalidateTaskCacheFn = func(context.Context) error {
		if !deleted {
			t.Fatal("epoch invalidated before deletion")
		}
		invalidated = true
		return nil
	}
	err := f.tasks.Delete(ctx, f.principal, f.project.ID, current.ID, taskcore.DeleteTask{Version: current.Version})
	if err != nil || !deleted || !invalidated {
		t.Fatalf("delete: %v", err)
	}
}

func TestGoalEndRejectsFreshClaimButAllowsReleasedResume(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskDone, model.TaskCancelled} {
		t.Run(string(status), func(t *testing.T) {
			owner := workerServicePrincipal()
			current := workerServiceTask(t, owner)
			current.Type = model.TaskTypeTask
			parentID := "30000000-0000-4000-8000-000000000001"
			current.ParentID = &parentID
			parent := model.Task{ID: parentID, ProjectID: current.ProjectID, Type: model.TaskTypeGoal, Status: status}
			fresh := workerDescriptor()
			f := workerMockWrite(t, current, owner)
			parentReads := 0
			f.Task.ParentTaskFn = func(ctx context.Context, id string) (model.Task, error) {
				parentReads++
				if ctx != f.Context || id != parentID || parentReads != 1 {
					t.Fatal("parent lookup escaped claim transaction")
				}
				return parent, nil
			}
			got, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: fresh})
			requireFault(t, err, "invalid_transition")
			if parentReads != 1 || !reflect.DeepEqual(got, model.Task{}) {
				t.Fatalf("claim refusal returned %+v", got)
			}

			old := workerDescriptor()
			released := current
			previous := &model.WorkerClaim{ClaimID: old.ClaimID, WorkerID: old.WorkerID, UserID: owner.UserID, Machine: old.Machine, Platform: old.Platform, Agent: old.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: old.WorktreeID, State: model.WorkerReleased, Phase: model.WorkerPreparing, ClaimedAt: current.UpdatedAt}
			released.Properties = testWithWorker(t, current.Properties, previous)
			f = workerMockWrite(t, released, owner)
			f.Task.ParentTaskFn = func(context.Context, string) (model.Task, error) {
				t.Fatal("resume applied fresh claim parent gate")
				return model.Task{}, nil
			}
			claimedAt := released.UpdatedAt.Add(time.Second)
			f.Task.ObservedAtFn = func(context.Context) (time.Time, error) { return claimedAt, nil }
			worker := &model.WorkerClaim{ClaimID: fresh.ClaimID, WorkerID: fresh.WorkerID, UserID: owner.UserID, Machine: fresh.Machine, Platform: fresh.Platform, Agent: fresh.Agent, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: fresh.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
			resumed := workerTestResult(released)
			resumed.Status, resumed.Ready, resumed.StartedAt = model.TaskInProgress, false, &claimedAt
			resumed.Properties = testWithWorker(t, released.Properties, worker)
			values := taskcore.CurrentWrite(released)
			values.Status, values.Properties = resumed.Status, resumed.Properties
			workerExpectUpdate(t, f, values, resumed)
			got, err = f.Tasks.ResumeWorker(f.Context, owner, released.ProjectID, released.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: released.Version, WorkerDescriptor: fresh}, PreviousClaimID: old.ClaimID})
			if err != nil || !reflect.DeepEqual(got, resumed) {
				t.Fatalf("resume %+v %v", got, err)
			}
		})
	}
}
