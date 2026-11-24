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

func TestGoalDeletePreservesEpochWithoutChildOrExecutionEffects(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.Type = model.TaskTypeGoal
	current.Ready = false
	f.current(ctx, current)
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	deleted := false
	f.writer.DeleteTaskFn = func(_ context.Context, id string, remove bool) (model.TaskTombstone, error) {
		if id != current.ID || remove {
			t.Fatal("wrong Goal deletion")
		}
		deleted = true
		return model.TaskTombstone{ID: id, ProjectID: current.ProjectID, Version: current.Version + 1, DeletedAt: current.UpdatedAt}, nil
	}
	f.projectWriter.InvalidateTaskCacheFn = func(context.Context) error {
		t.Fatal("ordinary Goal deletion rotated the project epoch")
		return nil
	}
	err := f.tasks.Delete(ctx, f.principal, f.project.ID, current.ID, taskcore.DeleteTask{Version: current.Version})
	if err != nil || !deleted {
		t.Fatalf("delete: %v", err)
	}
}

func TestGoalEndRejectsFreshClaim(t *testing.T) {
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

		})
	}
}

func TestGoalRemoveExecutionPropertyIsRefused(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(map[bool]string{false: "current version", true: "stale version"}[stale], func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			goal := f.target
			goal.Type = model.TaskTypeGoal
			goal.Ready = false
			f.current(ctx, goal)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			version := goal.Version
			if stale {
				version++
			}
			got, err := f.tasks.RemoveProperty(ctx, f.principal, f.project.ID, goal.ID, "paused", version)
			code := "invalid_input"
			if stale {
				code = "version_conflict"
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != code || !reflect.DeepEqual(got, model.Task{}) {
				t.Fatalf("remove execution property: %+v %v", got, err)
			}
		})
	}
}

func TestDeletedLifecycleTargetRefusedBeforeWrite(t *testing.T) {
	for _, operation := range []string{"status", "delete"} {
		for _, typ := range []model.TaskType{model.TaskTypeTask, model.TaskTypeGoal} {
			for _, deletedBy := range []string{"header", "error"} {
				t.Run(operation+"/"+string(typ)+"/"+deletedBy, func(t *testing.T) {
					f := newTaskRuleFixture(t)
					ctx := t.Context()
					deletedAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
					reads, access, headers, writes := 0, 0, 0, 0
					f.projectReader.ProjectAccessFn = func(actual context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
						access++
						if actual != ctx || principal != f.principal || project != f.project.ID {
							t.Fatal("preflight authorization changed context or identity")
						}
						return taskMockAccess(f.project, principal), nil
					}
					f.reader.TaskHeaderFn = func(actual context.Context, project, id string) (model.TaskHeader, error) {
						headers++
						if actual != ctx || project != f.project.ID || id != f.target.ID {
							t.Fatal("preflight header changed context or identity")
						}
						if deletedBy == "error" {
							return model.TaskHeader{}, model.ErrTaskDeleted
						}
						return model.TaskHeader{ProjectID: project, ID: id, Type: typ, DeletedAt: &deletedAt}, nil
					}
					f.database.ReadSnapshotFn = func(actual context.Context, work func(store.SnapshotScope) error) error {
						reads++
						if actual != ctx || work == nil {
							t.Fatal("preflight changed context or callback")
						}
						return work(f.snapshot)
					}
					f.database.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
						writes++
						t.Error("deleted preflight target entered a write transaction")
						return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("unexpected write")
					}
					var err error
					if operation == "status" {
						var got model.Task
						got, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: model.TaskDone})
						if !reflect.DeepEqual(got, model.Task{}) {
							t.Fatalf("deleted status returned a Task: %+v", got)
						}
					} else {
						err = f.tasks.Delete(ctx, f.principal, f.project.ID, f.target.ID, taskcore.DeleteTask{Version: f.target.Version})
					}
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != "task_deleted" || !errors.Is(err, model.ErrTaskDeleted) || reads != 1 || access != 1 || headers != 1 || writes != 0 {
						t.Fatalf("deleted preflight: error=%v reads=%d access=%d headers=%d writes=%d", err, reads, access, headers, writes)
					}
				})
			}
		}
	}
}

func TestDeletedLifecyclePreflightCompletionFailurePrecedesRefusal(t *testing.T) {
	for _, operation := range []string{"status", "delete"} {
		t.Run(operation, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			failure := errors.New("snapshot completion failed")
			f.reader.TaskHeaderFn = func(context.Context, string, string) (model.TaskHeader, error) {
				return model.TaskHeader{}, model.ErrTaskDeleted
			}
			f.database.ReadSnapshotFn = func(_ context.Context, work func(store.SnapshotScope) error) error {
				if err := work(f.snapshot); err != nil {
					t.Fatalf("preflight refusal escaped callback: %v", err)
				}
				return failure
			}
			writes := 0
			f.database.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
				writes++
				t.Error("failed preflight entered a write transaction")
				return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("unexpected write")
			}
			var err error
			if operation == "status" {
				_, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: model.TaskDone})
			} else {
				err = f.tasks.Delete(ctx, f.principal, f.project.ID, f.target.ID, taskcore.DeleteTask{Version: f.target.Version})
			}
			var fault *model.Fault
			if !errors.Is(err, failure) || errors.As(err, &fault) || writes != 0 {
				t.Fatalf("preflight completion failure lost: error=%v writes=%d", err, writes)
			}
		})
	}
}
