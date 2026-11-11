package task_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func assertOperational(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) {
		t.Fatalf("operational error was masked: %#v", err)
	}
}

type taskFailureFixture struct {
	ctx            context.Context
	project        model.Project
	target         model.Task
	principal      model.Principal
	database       *taskStoreMock
	scope          *taskProjectScopeMock
	projects       *projectWriterMock
	tasks          *taskWriterMock
	sessions       *projectSessionMock
	callbackError  error
	writeCalls     int
	expectedWrites int
}

func newTaskFailureFixture(t *testing.T, ctx context.Context, outcome store.TransactionOutcome) *taskFailureFixture {
	t.Helper()
	project, target, principal := taskMockModels()
	base := newTaskMockBase(t, "store")
	f := &taskFailureFixture{ctx: ctx, project: project, target: target, principal: principal, expectedWrites: 1,
		database: &taskStoreMock{taskMockBase: base},
		scope:    &taskProjectScopeMock{taskMockBase: base.withLabel("scope")},
		projects: &projectWriterMock{taskMockBase: base.withLabel("projects")},
		tasks:    &taskWriterMock{taskMockBase: base.withLabel("tasks")},
		sessions: &projectSessionMock{taskMockBase: base.withLabel("sessions")}}
	f.scope.ProjectDAOFn = func() store.ProjectWriteDAO { return f.projects }
	f.scope.TaskDAOFn = func() store.TaskWriteDAO { return f.tasks }
	f.projects.ProjectAccessFn = func(actual context.Context, actor model.Principal) (model.ProjectAccess, error) {
		if actual != ctx || actor != principal {
			t.Fatal("Project access changed context or principal")
		}
		return taskMockAccess(project, principal), nil
	}
	f.database.WriteProjectFn = func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		if actual != ctx || id != project.ID || work == nil {
			t.Fatal("Project writer changed context, identity or callback")
		}
		f.writeCalls++
		if f.writeCalls > f.expectedWrites {
			t.Fatal("unexpected additional Project write")
		}
		f.callbackError = work(f.scope)
		return store.Completion{Outcome: outcome}, f.callbackError
	}
	t.Cleanup(func() {
		if f.writeCalls != f.expectedWrites {
			t.Fatalf("Project write calls: %d, want %d", f.writeCalls, f.expectedWrites)
		}
	})
	return f
}

func (f *taskFailureFixture) expectTask(t *testing.T, target model.Task) {
	t.Helper()
	called := false
	f.tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		if called {
			t.Fatal("unexpected additional Task lookup")
		}
		called = true
		if ctx != f.ctx || id != target.ID {
			t.Fatal("Task lookup changed context or identity")
		}
		return target, nil
	}
}

func (f *taskFailureFixture) expectPrerequisites(t *testing.T, prerequisites []model.Task) {
	t.Helper()
	called := false
	f.tasks.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
		if called {
			t.Fatal("unexpected additional prerequisite lookup")
		}
		called = true
		expected := make([]string, len(prerequisites))
		for i, prerequisite := range prerequisites {
			expected[i] = prerequisite.ID
		}
		if ctx != f.ctx || !slices.Equal(ids, expected) {
			t.Fatalf("prerequisite lookup: %v, want %v", ids, expected)
		}
		return prerequisites, nil
	}
	f.tasks.VisibleTaskIDsFn = func(ctx context.Context, ids []string) ([]string, error) {
		if ctx != f.ctx {
			t.Fatal("dependency visibility query changed context")
		}
		for _, id := range ids {
			if !slices.ContainsFunc(prerequisites, func(task model.Task) bool { return task.ID == id }) {
				t.Fatalf("unexpected dependency visibility query: %v", ids)
			}
		}
		return slices.Clone(ids), nil
	}
}

func TestTaskReadAndWriteDAOFailures(t *testing.T) {
	for _, source := range []string{"tasks", "projects"} {
		t.Run(source, func(t *testing.T) {
			ctx := t.Context()
			project, target, principal := taskMockModels()
			cause := errors.New(source + " unavailable")
			base := newTaskMockBase(t, "store")
			projectReader := &projectReaderMock{taskMockBase: base.withLabel("projects")}
			reader := &taskReaderMock{taskMockBase: base.withLabel("tasks")}
			snapshot := &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot"), ProjectDAOFn: func() store.ProjectReader { return projectReader }, TaskDAOFn: func() store.TaskReader { return reader }}
			projectReader.ProjectAccessFn = func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
				if source == "projects" {
					return model.ProjectAccess{}, cause
				}
				return taskMockAccess(project, principal), nil
			}
			reader.TaskFn = func(context.Context, string, string) (model.Task, error) { return model.Task{}, cause }
			reader.TasksFn = func(context.Context, string, store.TaskQuery) (store.TaskPage, error) { return store.TaskPage{}, cause }
			f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
			f.expectedWrites = 5
			f.database.ReadSnapshotFn = func(actual context.Context, work func(store.SnapshotScope) error) error {
				if actual != ctx {
					t.Fatal("snapshot changed context")
				}
				return work(snapshot)
			}
			if source == "projects" {
				f.projects.ProjectAccessFn = func(context.Context, model.Principal) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, cause
				}
			}
			f.tasks.TaskFn = func(context.Context, string) (model.Task, error) { return model.Task{}, cause }
			f.tasks.TasksByIDFn = func(context.Context, []string) ([]model.Task, error) { return nil, cause }
			tasks := taskservice.NewTasks(f.database)
			_, getErr := tasks.Get(ctx, principal, project.ID, target.ID)
			_, listErr := tasks.List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}})
			_, updateErr := tasks.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed")})
			_, createErr := tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "New"})
			failures := []error{getErr, listErr, updateErr, createErr}
			for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
				_, err := tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: status})
				failures = append(failures, err)
			}
			for _, err := range failures {
				assertOperational(t, err)
				if !errors.Is(err, cause) {
					t.Fatalf("lost DAO cause: %v", err)
				}
			}
		})
	}
	ctx := t.Context()
	project, _, principal := taskMockModels()
	cause := errors.New("snapshot reader closed")
	database := &taskStoreMock{taskMockBase: newTaskMockBase(t, "store"), ReadSnapshotFn: func(context.Context, func(store.SnapshotScope) error) error { return cause }}
	_, err := taskservice.NewTasks(database).List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}})
	assertOperational(t, err)
	if !errors.Is(err, cause) {
		t.Fatalf("closed reader cause: %v", err)
	}
}

func TestTaskPolicyQueryCancellationPreservesCause(t *testing.T) {
	for _, step := range []string{"prerequisites", "reachability"} {
		t.Run(step, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
			target := f.target
			prerequisite := target
			prerequisite.ID = "66666666-6666-4666-8666-666666666666"
			prerequisite.Status = model.TaskDone
			target.DependsOn = []string{prerequisite.ID}
			target.Status = model.TaskDone
			f.expectTask(t, target)
			f.tasks.TasksByIDFn = func(actual context.Context, ids []string) ([]model.Task, error) {
				if actual != ctx || !slices.Equal(ids, target.DependsOn) {
					t.Fatal("wrong prerequisite lookup")
				}
				if step == "prerequisites" {
					cancel()
					return nil, actual.Err()
				}
				return []model.Task{prerequisite}, nil
			}
			f.tasks.ReachableFn = func(actual context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
				if actual != ctx || from != prerequisite.ID || to != target.ID || replacement.TaskID != target.ID || !slices.Equal(replacement.DependsOn, target.DependsOn) {
					t.Fatal("wrong reachability lookup")
				}
				cancel()
				return false, actual.Err()
			}
			_, err := taskservice.NewTasks(f.database).Update(ctx, f.principal, f.project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Rejected")})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) || !errors.Is(f.callbackError, context.Canceled) {
				t.Fatalf("query cancellation cause: %v", err)
			}
		})
	}
}

func TestTaskStatusQueryCancellationPreservesCauseAndState(t *testing.T) {
	for _, action := range []struct{ from, to model.TaskStatus }{{model.TaskTodo, model.TaskInProgress}, {model.TaskInProgress, model.TaskDone}, {model.TaskDone, model.TaskTodo}} {
		t.Run(fmt.Sprintf("%s_to_%s", action.from, action.to), func(t *testing.T) {
			for _, step := range []string{"read", "write", "after-write"} {
				t.Run(step, func(t *testing.T) {
					ctx, cancel := context.WithCancel(t.Context())
					defer cancel()
					f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
					target := f.target
					target.Status = action.from
					before := target
					f.tasks.TaskFn = func(context.Context, string) (model.Task, error) {
						if step == "read" {
							cancel()
							return model.Task{}, ctx.Err()
						}
						return target, nil
					}
					if action.from == model.TaskDone {
						f.tasks.ActiveDependentIDsFn = func(context.Context, string) ([]string, error) { return []string{}, nil }
					}
					f.tasks.UpdateTaskFn = func(actual context.Context, id string, values store.TaskWrite) (model.Task, error) {
						if actual != ctx || id != target.ID || values.Status != action.to || values.Title != target.Title || values.Description != target.Description {
							t.Fatal("status mutation changed unrelated values")
						}
						cancel()
						if step == "write" {
							return model.Task{}, actual.Err()
						}
						result := target
						result.Status = values.Status
						result.Version++
						return result, nil
					}
					f.scope.SessionDAOFn = func() store.ProjectSessionDAO { return f.sessions }
					f.sessions.DrainTaskSessionsFn = func(actual context.Context, id string, _ store.TaskSessionDrain) error {
						if actual != ctx || id != target.ID {
							t.Fatal("wrong session drain")
						}
						return actual.Err()
					}
					result, err := taskservice.NewTasks(f.database).SetStatus(ctx, f.principal, f.project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: action.to})
					assertOperational(t, err)
					if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(target, before) || result.ID != "" {
						t.Fatalf("status cancellation result/cause/input: %#v, %v", result, err)
					}
				})
			}
		})
	}
}

func TestTaskPartialWriteFailurePreservesCauseAndCandidate(t *testing.T) {
	for _, operation := range []string{"create", "update"} {
		t.Run(operation, func(t *testing.T) {
			ctx := t.Context()
			f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
			first := f.target
			first.ID = "66666666-6666-4666-8666-666666666666"
			second := f.target
			second.ID = "77777777-7777-4777-8777-777777777777"
			dependencies := []string{first.ID, second.ID}
			if operation == "update" {
				f.expectTask(t, f.target)
			}
			f.expectPrerequisites(t, []model.Task{first, second})
			f.tasks.ReachableFn = func(context.Context, string, string, store.DependencyReplacement) (bool, error) { return false, nil }
			privateCause := errors.New("private edge diagnostic")
			cause := &store.Error{Phase: "operation", SQLState: "P1001", DatabaseFailure: true, Cause: privateCause}
			write := func(actual context.Context, id string, values store.TaskWrite) (model.Task, error) {
				if actual != ctx || (operation == "update" && id != f.target.ID) || values.Title != "Changed" || values.Description != "Changed" || !slices.Equal(values.DependsOn, dependencies) || !slices.Equal(testPRs(t, values.Properties), []model.PullRequestProperty{{URL: "changed", Title: "Changed"}}) {
					t.Fatalf("wrong write candidate: %#v", values)
				}
				return model.Task{}, cause
			}
			f.tasks.UpdateTaskFn = write
			f.tasks.CreateTaskFn = write
			tasks := taskservice.NewTasks(f.database)
			var result model.Task
			var err error
			properties := propertyPatch(model.PullRequestProperty{URL: "changed", Title: "Changed"})
			if operation == "update" {
				result, err = tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, Title: pointer("Changed"), Description: pointer("Changed"), DependsOn: &dependencies, Properties: properties})
			} else {
				result, err = tasks.Create(ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Changed", Description: "Changed", DependsOn: dependencies, Properties: properties})
			}
			assertOperational(t, err)
			var failure *store.Error
			if result.ID != "" || !errors.Is(err, cause) || !errors.Is(err, privateCause) || !errors.As(err, &failure) || failure != cause || strings.Contains(err.Error(), "private edge") || f.callbackError != cause {
				t.Fatalf("partial-write result/cause: %#v %v", result, err)
			}
		})
	}
}

func TestTaskReadUsesOneScopeForProjectAndDerivedState(t *testing.T) {
	ctx := t.Context()
	project, target, principal := taskMockModels()
	prerequisiteID := "66666666-6666-4666-8666-666666666666"
	target.DependsOn = []string{prerequisiteID}
	target.BlockedBy = []string{prerequisiteID}
	target.Ready = false
	base := newTaskMockBase(t, "store")
	projects := &projectReaderMock{taskMockBase: base.withLabel("projects"), ProjectAccessFn: func(actual context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		if actual != ctx || p != principal || id != project.ID {
			t.Fatal("wrong project access")
		}
		return taskMockAccess(project, principal), nil
	}}
	reader := &taskReaderMock{taskMockBase: base.withLabel("tasks"), TaskFn: func(actual context.Context, p, id string) (model.Task, error) {
		if actual != ctx || p != project.ID || id != target.ID {
			t.Fatal("wrong Task read")
		}
		return target, nil
	}}
	scope := &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot"), ProjectDAOFn: func() store.ProjectReader { return projects }, TaskDAOFn: func() store.TaskReader { return reader }}
	snapshots := 0
	database := &taskStoreMock{taskMockBase: base, ReadSnapshotFn: func(actual context.Context, work func(store.SnapshotScope) error) error {
		if actual != ctx {
			t.Fatal("snapshot context changed")
		}
		snapshots++
		return work(scope)
	}}
	result, err := taskservice.NewTasks(database).Get(ctx, principal, project.ID, target.ID)
	if err != nil || snapshots != 1 || !reflect.DeepEqual(result, target) {
		t.Fatalf("scope-bound derived read: %#v %v", result, err)
	}
	if got := base.trace.snapshot(); !slices.Equal(got, []string{"store.ReadSnapshot", "snapshot.ProjectDAO", "projects.ProjectAccess", "snapshot.TaskDAO", "tasks.Task"}) {
		t.Fatalf("read scope order: %v", got)
	}
}

func TestTaskReopenDependentQueryCancellationPreservesCause(t *testing.T) {
	for _, after := range []bool{false, true} {
		t.Run(fmt.Sprintf("after=%t", after), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
			target := f.target
			target.Status = model.TaskDone
			f.expectTask(t, target)
			f.tasks.ActiveDependentIDsFn = func(actual context.Context, id string) ([]string, error) {
				if actual != ctx || id != target.ID {
					t.Fatal("wrong dependent query")
				}
				cancel()
				if !after {
					return nil, actual.Err()
				}
				return []string{}, nil
			}
			f.tasks.UpdateTaskFn = func(actual context.Context, _ string, _ store.TaskWrite) (model.Task, error) {
				return model.Task{}, actual.Err()
			}
			_, err := taskservice.NewTasks(f.database).SetStatus(ctx, f.principal, f.project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskTodo})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("dependent cancellation cause: %v", err)
			}
		})
	}
}

func TestTaskStatusWriteFailurePreservesTimingAndMaterialsCandidate(t *testing.T) {
	ctx := t.Context()
	f := newTaskFailureFixture(t, ctx, store.TransactionNotCommitted)
	prerequisiteID := "66666666-6666-4666-8666-666666666666"
	target := f.target
	target.Title = "Original"
	target.Description = "Preserved Markdown"
	target.DependsOn = []string{prerequisiteID}
	target.ExternalDependsOn = []string{prerequisiteID}
	target.AllowAgents = true
	target.Properties = propertyPatch(model.PullRequestProperty{URL: "https://github.com/owner/repo/pull/1", Title: "Existing evidence"})
	f.expectTask(t, target)
	privateCause := errors.New("private status edge diagnostic")
	cause := &store.Error{Phase: "operation", SQLState: "P0001", DatabaseFailure: true, Cause: privateCause}
	f.tasks.UpdateTaskFn = func(actual context.Context, id string, values store.TaskWrite) (model.Task, error) {
		if actual != ctx || id != target.ID || values.Status != model.TaskInProgress || values.Title != target.Title || values.Description != target.Description || values.AllowAgents != target.AllowAgents || !slices.Equal(values.DependsOn, target.DependsOn) || !slices.Equal(values.ExternalDependsOn, target.ExternalDependsOn) || !reflect.DeepEqual(values.Properties, target.Properties) {
			t.Fatalf("status changed materials: %#v", values)
		}
		return model.Task{}, cause
	}
	_, err := taskservice.NewTasks(f.database).SetStatus(ctx, f.principal, f.project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskInProgress})
	assertOperational(t, err)
	var failure *store.Error
	if !errors.Is(err, privateCause) || !errors.As(err, &failure) || failure != cause || strings.Contains(err.Error(), "private status edge") {
		t.Fatalf("lost status failure cause or redaction: %v", err)
	}
}
