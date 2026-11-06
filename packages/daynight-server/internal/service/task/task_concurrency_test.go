package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"

	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

type taskResult struct {
	task model.Task
	err  error
}

func waitForTaskWriters(t *testing.T, ctx context.Context, database *postgres.Store, count int) {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting int
		err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE application_name = current_setting('application_name') AND wait_event_type = 'Lock'
			AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE'`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting >= count {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%d task writers never reached their own project lock: %v", count, ctx.Err())
		case <-ticker.C:
		}
	}
}

func receiveTaskResult(t *testing.T, ctx context.Context, result <-chan taskResult) taskResult {
	t.Helper()
	select {
	case result := <-result:
		return result
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return taskResult{}
	}
}

func competeTaskWrites(t *testing.T, database *postgres.Store, projectID string, operations ...func(context.Context) (model.Task, error)) []taskResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := make(chan taskResult, len(operations))
	if err := writeProjectForTest(database, ctx, projectID, func(store.ProjectWriteScope) error {
		for _, operation := range operations {
			go func() {
				task, err := operation(ctx)
				result <- taskResult{task: task, err: err}
			}()
		}
		waitForTaskWriters(t, ctx, database, len(operations))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	results := make([]taskResult, 0, len(operations))
	for range operations {
		results = append(results, receiveTaskResult(t, ctx, result))
	}
	return results
}

func assertOneTaskWinner(t *testing.T, results []taskResult, code string) {
	t.Helper()
	success, refused := 0, 0
	for _, result := range results {
		if result.err == nil {
			success++
		} else {
			requireFault(t, result.err, code)
			refused++
		}
	}
	if success != 1 || refused != 1 {
		t.Fatalf("expected one winning write and one %s refusal, got %#v", code, results)
	}
}

func TestConcurrentReverseDependenciesCannotCreateCycle(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, a.ID, taskcore.UpdateTask{Version: a.Version, DependsOn: pointer([]string{b.ID})})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, b.ID, taskcore.UpdateTask{Version: b.Version, DependsOn: pointer([]string{a.ID})})
		})
	assertOneTaskWinner(t, results, "dependency_cycle")
	afterA, err := tasks.Get(context.Background(), principal, project.ID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	afterB, err := tasks.Get(context.Background(), principal, project.ID, b.ID)
	if err != nil || len(afterA.DependsOn)+len(afterB.DependsOn) != 1 || afterA.Version+afterB.Version != 3 {
		t.Fatalf("reverse edges persisted an invalid graph: A %#v, B %#v, %v", afterA, afterB, err)
	}
}

func TestConcurrentDependencyReplacementAndStartPreserveStateInvariant(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	predecessor := createTask(t, tasks, principal, project.ID, "Unfinished prerequisite")
	dependent := createTask(t, tasks, principal, project.ID, "Dependent")

	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, dependent.ID, taskcore.UpdateTask{Version: dependent.Version, DependsOn: pointer([]string{predecessor.ID})})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.SetStatus(ctx, principal, project.ID, dependent.ID, taskcore.SetTaskStatus{Version: dependent.Version, Status: model.TaskInProgress})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(context.Background(), principal, project.ID, dependent.ID)
	if err != nil || after.Version != dependent.Version+1 {
		t.Fatalf("concurrent dependency/start result: %#v, %v", after, err)
	}
	if after.Status == model.TaskInProgress {
		if len(after.DependsOn) != 0 || len(after.BlockedBy) != 0 {
			t.Fatalf("started task acquired unfinished prerequisite: %#v", after)
		}
	} else if after.Status != model.TaskTodo || len(after.DependsOn) != 1 || after.DependsOn[0] != predecessor.ID || after.Ready {
		t.Fatalf("dependency replacement lost blocked todo state: %#v", after)
	}
	assertTaskUnchanged(t, tasks, principal, predecessor)
}

func TestConcurrentSetStatusSameVersionOnlyChangesOnce(t *testing.T) {
	for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		t.Run(string(to), func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			target := createTask(t, tasks, principal, project.ID, "Concurrent status")
			if to == model.TaskTodo {
				target = startTask(t, tasks, principal, target)
			}
			write := func(ctx context.Context) (model.Task, error) {
				return tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: to})
			}
			results := competeTaskWrites(t, database, project.ID, write, write)
			assertOneTaskWinner(t, results, "version_conflict")
			after, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
			if err != nil || after.Status != to || after.Version != target.Version+1 {
				t.Fatalf("status competition: %#v %v", after, err)
			}
		})
	}
}

func TestConcurrentSameStatusIsReadOnly(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Same status")
	write := func(ctx context.Context) (model.Task, error) {
		return tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskTodo})
	}
	for _, result := range competeTaskWrites(t, database, project.ID, write, write) {
		if result.err != nil || result.task.Version != target.Version {
			t.Fatalf("same-state competition: %#v", result)
		}
	}
	assertTaskUnchanged(t, tasks, principal, target)
}

func TestConcurrentSameVersionUpdatesOnlyChangeOnce(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Original")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("First"), Properties: propertyPatch(model.PullRequestProperty{URL: "first", Title: "First"})})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Second"), Properties: propertyPatch(model.PullRequestProperty{URL: "second", Title: "Second"})})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || after.Version != target.Version+1 || (after.Title != "First" && after.Title != "Second") {
		t.Fatalf("version competition: %#v, %v", after, err)
	}
	want := []model.PullRequestProperty{{URL: strings.ToLower(after.Title), Title: after.Title}}
	if got := testPRs(t, after.Properties); !slices.Equal(got, want) {
		t.Fatalf("concurrent update mixed title and properties: %#v", after)
	}
}

func TestConcurrentReopenAndSuccessorStartPreserveStateInvariant(t *testing.T) {
	for _, external := range []bool{false, true} {
		for _, to := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
			t.Run(string(to)+fmt.Sprint(external), func(t *testing.T) {
				tasks, database, project, _, principal := taskService(t)
				predecessor := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Prerequisite"))
				successor := createTask(t, tasks, principal, project.ID, "Successor", predecessor.ID)
				if external {
					successor = updateTask(t, tasks, principal, successor, taskcore.UpdateTask{ExternalDependsOn: pointer([]string{predecessor.ID})})
				}
				results := competeTaskWrites(t, database, project.ID,
					func(ctx context.Context) (model.Task, error) {
						return tasks.SetStatus(ctx, principal, project.ID, predecessor.ID, taskcore.SetTaskStatus{Version: predecessor.Version, Status: model.TaskTodo})
					},
					func(ctx context.Context) (model.Task, error) {
						return tasks.SetStatus(ctx, principal, project.ID, successor.ID, taskcore.SetTaskStatus{Version: successor.Version, Status: to})
					})
				assertOneTaskWinner(t, results, "dependency_unsatisfied")
				afterPredecessor, err := tasks.Get(context.Background(), principal, project.ID, predecessor.ID)
				if err != nil {
					t.Fatal(err)
				}
				afterSuccessor, err := tasks.Get(context.Background(), principal, project.ID, successor.ID)
				if err != nil {
					t.Fatal(err)
				}
				wantExternal := []string{}
				if external {
					wantExternal = append(wantExternal, predecessor.ID)
				}
				if !slices.Equal(afterSuccessor.ExternalDependsOn, wantExternal) {
					t.Fatal("race changed external dependency classification")
				}
				if afterPredecessor.Status == model.TaskTodo {
					expected := successor
					expected.Ready = false
					expected.BlockedBy = []string{predecessor.ID}
					if afterPredecessor.Version != predecessor.Version+1 || !reflect.DeepEqual(afterSuccessor, expected) {
						t.Fatalf("reopen winner changed successor or blocking: %#v %#v", afterPredecessor, afterSuccessor)
					}
				} else if !reflect.DeepEqual(afterPredecessor, predecessor) || afterSuccessor.Status != to || afterSuccessor.Version != successor.Version+1 || len(afterSuccessor.BlockedBy) != 0 {
					t.Fatalf("successor winner changed prerequisite or blocking: %#v %#v", afterPredecessor, afterSuccessor)
				}
			})
		}
	}
}

func TestTaskLockWaitCancellationAndIndependentProjectProgress(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	otherProject, err := projectservice.NewProjects(database).Create(context.Background(), principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Other", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	other := createTask(t, tasks, principal, otherProject.ID, "Other task")
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	result := make(chan taskResult, 1)
	if err := writeProjectForTest(database, ctx, project.ID, func(store.ProjectWriteScope) error {
		waiting, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			task, err := tasks.Update(waiting, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Late write")})
			result <- taskResult{task: task, err: err}
		}()
		waitForTaskWriters(t, ctx, database, 1)
		independent, done := context.WithTimeout(ctx, 2*time.Second)
		defer done()
		updated, err := tasks.Update(independent, principal, otherProject.ID, other.ID, taskcore.UpdateTask{Version: other.Version, Title: pointer("Independent")})
		if err != nil || updated.Title != "Independent" {
			t.Fatalf("unrelated project write was blocked: %#v, %v", updated, err)
		}
		cancel()
		failed := receiveTaskResult(t, ctx, result)
		assertOperational(t, failed.err)
		if !errors.Is(failed.err, context.Canceled) || strings.Contains(failed.err.Error(), "Late write") {
			t.Fatalf("canceled row-lock wait lost cause or exposed metadata: %v", failed.err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	assertTaskUnchanged(t, tasks, principal, target)
	after := updateTask(t, tasks, principal, target, taskcore.UpdateTask{Title: pointer("Reused lock")})
	if after.Version != target.Version+1 || after.Title != "Reused lock" {
		t.Fatalf("lock could not be reused after cancellation: %#v", after)
	}
}

func TestConcurrentReopenAndActiveSuccessorEdgeWritePreserveInvariant(t *testing.T) {
	for _, external := range []bool{false, true} {
		for _, activeStatus := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
			t.Run(string(activeStatus)+fmt.Sprint(external), func(t *testing.T) {
				tasks, database, project, _, principal := taskService(t)
				predecessor := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Predecessor"))
				successor := setStatusTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Active successor"), activeStatus)
				dependencies := []string{predecessor.ID}
				externalDependencies := []string{}
				if external {
					externalDependencies = dependencies
				}
				results := competeTaskWrites(t, database, project.ID,
					func(ctx context.Context) (model.Task, error) {
						return tasks.SetStatus(ctx, principal, project.ID, predecessor.ID, taskcore.SetTaskStatus{Version: predecessor.Version, Status: model.TaskTodo})
					},
					func(ctx context.Context) (model.Task, error) {
						return tasks.Update(ctx, principal, project.ID, successor.ID, taskcore.UpdateTask{Version: successor.Version, DependsOn: &dependencies, ExternalDependsOn: &externalDependencies})
					})
				assertOneTaskWinner(t, results, "dependency_unsatisfied")
				afterPredecessor, err := tasks.Get(context.Background(), principal, project.ID, predecessor.ID)
				if err != nil {
					t.Fatal(err)
				}
				afterSuccessor, err := tasks.Get(context.Background(), principal, project.ID, successor.ID)
				if err != nil {
					t.Fatal(err)
				}
				if len(afterSuccessor.DependsOn) > 0 && afterPredecessor.Status != model.TaskDone {
					t.Fatal("active successor gained unfinished prerequisite")
				}
				if afterPredecessor.Version+afterSuccessor.Version != predecessor.Version+successor.Version+1 {
					t.Fatal("edge race changed more than one record")
				}
			})
		}
	}
}

func TestConcurrentDifferentStatusTargetsHaveOneWinner(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Different status targets")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskInProgress})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskDone})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	after, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || after.Version != target.Version+1 || (after.Status != model.TaskInProgress && after.Status != model.TaskDone) || len(after.DependsOn) != 0 || len(after.BlockedBy) != 0 || after.Ready {
		t.Fatalf("different status competition: %#v, %v", after, err)
	}
}
