package task_test

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskDeletionRemoveDependsWithoutReferences(t *testing.T) {
	f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
	target := f.target
	f.expectTask(t, target)
	expectTaskDeletion(t, f, target, true)
	if err := taskDeletionService(t, f, target, 1).Delete(f.ctx, f.principal, f.project.ID, target.ID, taskcore.DeleteTask{Version: target.Version, RemoveDepends: true}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskDeletionRemoveDependsRefusalsAndFailuresPreserveCause(t *testing.T) {
	for _, scenario := range []string{"stale", "target-worker", "unauthorized", "epoch", "source-overflow"} {
		t.Run(scenario, func(t *testing.T) {
			outcome := store.TransactionCommitted
			if scenario == "epoch" || scenario == "source-overflow" {
				outcome = store.TransactionNotCommitted
			}
			f := newTaskFailureFixture(t, t.Context(), outcome)
			target := f.target
			version := target.Version
			code := ""
			caller := f.principal
			cause := errors.New(scenario + " failed")
			switch scenario {
			case "stale":
				version++
				code = "version_conflict"
			case "target-worker":
				target.Status = model.TaskInProgress
				target.Properties = taskDeletionWorker(t, model.WorkerActive)
				code = "invalid_transition"
			case "unauthorized":
				caller.UserID = "99999999-9999-4999-8999-999999999999"
				code = "not_found"
				f.projects.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
			}
			f.expectTask(t, target)
			tasks := taskservice.NewTasks(f.database)
			if scenario == "epoch" {
				expectTaskDeletion(t, f, target, true)
				tasks = taskDeletionService(t, f, target, 0)
				f.projects.InvalidateTaskCacheFn = func(context.Context) error { return cause }
			}
			if scenario == "source-overflow" {
				f.tasks.DeleteTaskFn = func(actual context.Context, id string, remove bool) (model.TaskTombstone, error) {
					if actual != f.ctx || id != target.ID || !remove {
						t.Fatal("wrong dependency-removing deletion")
					}
					return model.TaskTombstone{}, cause
				}
			}
			err := tasks.Delete(f.ctx, caller, f.project.ID, target.ID, taskcore.DeleteTask{Version: version, RemoveDepends: true})
			if code != "" {
				requireFault(t, err, code)
				if f.callbackError != nil {
					t.Fatal("business refusal escaped callback")
				}
			} else {
				assertOperational(t, err)
				if !errors.Is(err, cause) || f.callbackError != cause {
					t.Fatalf("lost removal failure: %v", err)
				}
			}
		})
	}
}
