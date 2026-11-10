package task_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskWritesPreserveDatabaseFailuresBeforeMutation(t *testing.T) {
	for _, method := range []string{"create", "update", "status"} {
		t.Run(method, func(t *testing.T) {
			ctx := t.Context()
			f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
			driver := errors.New("task query driver sentinel")
			database := &store.Error{Phase: "query", DatabaseFailure: true, SQLState: "42P01", Cause: driver}
			refusal := &model.Fault{Code: "invalid_input", Message: "joined domain refusal"}
			failure := errors.Join(refusal, database)
			calls := 0
			f.tasks.TaskFn = func(actual context.Context, id string) (model.Task, error) {
				calls++
				if actual != ctx || id != f.target.ID || calls != 1 {
					t.Fatal("task failure changed its lookup context, identity or call count")
				}
				return model.Task{}, failure
			}
			f.tasks.TasksByIDFn = func(actual context.Context, ids []string) ([]model.Task, error) {
				calls++
				if actual != ctx || len(ids) != 0 || calls != 1 {
					t.Fatal("create failure changed its dependency selection or call count")
				}
				return nil, failure
			}
			var got model.Task
			var err error
			tasks := taskservice.NewTasks(f.database)
			switch method {
			case "create":
				status := model.TaskTodo
				got, err = tasks.Create(ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Unwritten task", Status: &status})
			case "update":
				got, err = tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, Title: pointer("Unwritten update")})
			case "status":
				got, err = tasks.SetStatus(ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: model.TaskDone})
			}
			if calls != 1 || !reflect.DeepEqual(got, model.Task{}) || !errors.Is(f.callbackError, database) || !errors.Is(err, failure) || !errors.Is(err, driver) || !errors.Is(err, refusal) {
				t.Fatalf("database failure became a successful callback, lost a cause or exposed a task: task=%#v callback=%v err=%v", got, f.callbackError, err)
			}
			if _, known := operation.KnownFault(err); known {
				t.Fatalf("database failure became a recoverable domain refusal: %v", err)
			}
			failed, state := store.DatabaseErrorFacts(err)
			if !failed || state != "42P01" {
				t.Fatalf("write lost database classification: failure=%t state=%s", failed, state)
			}
		})
	}
}

func TestTaskStatusPreparationRetainsUnsafeCompletionFacts(t *testing.T) {
	for _, test := range []struct {
		phase   string
		outcome store.TransactionOutcome
		cleanup bool
	}{
		{"commit", store.TransactionUnknown, false},
		{"cleanup", store.TransactionNotCommitted, true},
		{"operation", store.TransactionUnknown, false},
	} {
		t.Run(test.phase+"_"+string(test.outcome), func(t *testing.T) {
			ctx := t.Context()
			f := newTaskFailureFixture(t, ctx, test.outcome)
			refusal := &model.Fault{Code: "invalid_input", Message: "business refusal sentinel"}
			cause := errors.New("transaction completion sentinel")
			failure := &store.TransactionError{Phase: test.phase, Outcome: test.outcome, CleanupFailed: test.cleanup, CommitAttempted: test.phase == "commit", Cause: errors.Join(refusal, context.Canceled, cause)}
			f.tasks.TaskFn = func(actual context.Context, id string) (model.Task, error) {
				if actual != ctx || id != f.target.ID {
					t.Fatal("unsafe completion changed the task lookup")
				}
				return model.Task{}, failure
			}
			got, err := taskservice.NewTasks(f.database).SetStatus(ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: model.TaskDone})
			var transaction *store.TransactionError
			if !reflect.DeepEqual(got, model.Task{}) || f.callbackError != failure || !errors.As(err, &transaction) || transaction != failure || !errors.Is(err, refusal) || !errors.Is(err, context.Canceled) || !errors.Is(err, cause) {
				t.Fatalf("unsafe completion became a pure refusal or lost its original facts: task=%#v transaction=%#v err=%v", got, transaction, err)
			}
			if _, known := operation.KnownFault(err); known || operation.CompletionFacts(err) != (operation.Facts{Outcome: test.outcome, Phase: test.phase, CleanupFailed: test.cleanup}) {
				t.Fatalf("unsafe completion was hidden by its joined refusal: %v", err)
			}
			want := []string{"store.WriteProject", "scope.ProjectDAO", "projects.ProjectAccess", "scope.TaskDAO", "tasks.Task"}
			if calls := f.database.trace.snapshot(); !slices.Equal(calls, want) {
				t.Fatalf("failed preparation executed additional business work: %v want%v", calls, want)
			}
		})
	}
}
