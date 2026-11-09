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
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskPropertiesCandidateFailureAndWriteErrorPropagation(t *testing.T) {
	project, target, _ := taskMockModels()
	old := target
	old.ID = "66666666-6666-4666-8666-666666666666"
	old.Status = model.TaskDone
	prerequisite := target
	prerequisite.ID = "77777777-7777-4777-8777-777777777777"
	target.Status = model.TaskInProgress
	target.StartedAt = pointer(target.UpdatedAt)
	target.DependsOn = []string{old.ID}
	target.Properties = propertyPatch(model.PullRequestProperty{URL: "old\x00", Title: "Old"})
	properties := propertyPatch(model.PullRequestProperty{URL: "changed\x00", Title: "Changed"})
	configureCandidate := func(t *testing.T, f *propertyWriteFixture, dependency model.Task) {
		f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			if ctx != f.ctx || !slices.Equal(ids, []string{prerequisite.ID}) {
				t.Fatalf("property candidate prerequisite selection: %v", ids)
			}
			return []model.Task{dependency}, nil
		}
		f.dao.ReachableFn = func(ctx context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
			if ctx != f.ctx || from != prerequisite.ID || to != target.ID || replacement.TaskID != target.ID || !slices.Equal(replacement.DependsOn, []string{prerequisite.ID}) {
				t.Fatalf("property replacement reachability: %#v", replacement)
			}
			return false, nil
		}
	}
	t.Run("candidate refused before writes", func(t *testing.T) {
		f := newPropertyWriteFixture(t, target, propertyCommit(t))
		configureCandidate(t, f, prerequisite)
		_, err := f.tasks.Update(f.ctx, f.principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}), Properties: properties})
		requireFault(t, err, "dependency_unsatisfied")
	})
	prerequisite.Status = model.TaskDone
	for _, failure := range []error{context.Canceled, errors.New("dependency write failed")} {
		t.Run(failure.Error(), func(t *testing.T) {
			f := newPropertyWriteFixture(t, target, propertyAbort(t, func(err error) {
				if !errors.Is(err, failure) {
					t.Fatalf("property callback lost write cause: %v", err)
				}
			}))
			configureCandidate(t, f, prerequisite)
			want := propertyExpectedWrite(target, properties)
			want.Title = "Changed"
			want.Description = "Changed"
			want.DependsOn = []string{prerequisite.ID}
			f.expectUpdate(want, model.Task{}, failure)
			actual, err := f.tasks.Update(f.ctx, f.principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed"), Description: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}), Properties: properties})
			assertOperational(t, err)
			if !errors.Is(err, failure) || !reflect.DeepEqual(actual, model.Task{}) {
				t.Fatalf("property write exposed failed candidate or changed cause: %#v %v", actual, err)
			}
		})
	}
	t.Run("failed create", func(t *testing.T) {
		failure := errors.New("dependency create failed")
		f := newPropertyWriteFixture(t, target, propertyAbort(t, func(err error) {
			if !errors.Is(err, failure) {
				t.Fatalf("create callback lost cause: %v", err)
			}
		}))
		f.wantReads = 0
		f.wantWrites = 1
		f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
			if ctx != f.ctx || !slices.Equal(ids, []string{prerequisite.ID}) {
				t.Fatal("create prerequisite selection changed")
			}
			return []model.Task{prerequisite}, nil
		}
		f.dao.ReachableFn = func(ctx context.Context, from, to string, r store.DependencyReplacement) (bool, error) {
			if ctx != f.ctx || from != prerequisite.ID || to != r.TaskID || !slices.Equal(r.DependsOn, []string{prerequisite.ID}) {
				t.Fatal("create dependency replacement changed")
			}
			return false, nil
		}
		f.dao.CreateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
			f.writes++
			if ctx != f.ctx || values.Title != "Rejected" || values.Status != model.TaskTodo || !propertyPropertiesEqual(t, values.Properties, properties) || !slices.Equal(values.DependsOn, []string{prerequisite.ID}) {
				t.Fatalf("create candidate: %#v", values)
			}
			return model.Task{}, failure
		}
		actual, err := f.tasks.Create(f.ctx, f.principal, project.ID, taskcore.CreateTask{Title: "Rejected", DependsOn: []string{prerequisite.ID}, Properties: properties})
		assertOperational(t, err)
		if !errors.Is(err, failure) || !reflect.DeepEqual(actual, model.Task{}) {
			t.Fatalf("failed create: %#v %v", actual, err)
		}
	})
}

func TestTaskPropertiesVersionAndSnapshotScope(t *testing.T) {
	project, target, principal := taskMockModels()
	first, second := propertyPatch(model.PullRequestProperty{URL: "first", Title: "First"}), propertyPatch(model.PullRequestProperty{URL: "second", Title: "Second"})
	for _, props := range []model.TaskProperties{first, second} {
		t.Run(string(props["pullRequests"]), func(t *testing.T) {
			result := propertyTaskResult(target, props)
			f := newPropertyWriteFixture(t, target, propertyCommit(t))
			f.dao.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
				if ctx != f.ctx || len(ids) != 0 {
					t.Fatal("property-only update changed dependencies")
				}
				return []model.Task{}, nil
			}
			f.expectUpdate(propertyExpectedWrite(target, props), result, nil)
			actual, err := f.tasks.Update(f.ctx, f.principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Properties: props})
			if err != nil || !reflect.DeepEqual(actual, result) {
				t.Fatalf("property update: %#v %v", actual, err)
			}
			t.Run("fresh version refuses stale write", func(t *testing.T) {
				stale := newPropertyWriteFixture(t, result, propertyCommit(t))
				_, err := stale.tasks.Update(stale.ctx, stale.principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Properties: second})
				requireFault(t, err, "version_conflict")
			})
		})
	}
	before := propertyTaskResult(target, first)
	after := propertyTaskResult(before, propertyPatch(model.PullRequestProperty{URL: "new", Title: "New"}))
	after.Title = "New snapshot"
	for _, current := range []model.Task{before, after} {
		t.Run(current.Title, func(t *testing.T) {
			base := newTaskMockBase(t, "property snapshot")
			accessCalls, taskCalls, scopeCalls := 0, 0, 0
			projects := &projectReaderMock{taskMockBase: base.withLabel("projects"), ProjectAccessFn: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
				accessCalls++
				if ctx != t.Context() || p != principal || id != project.ID {
					t.Fatal("property access changed snapshot scope")
				}
				return taskMockAccess(project, principal), nil
			}}
			reader := &taskReaderMock{taskMockBase: base.withLabel("tasks"), TaskFn: func(ctx context.Context, pid, id string) (model.Task, error) {
				taskCalls++
				if ctx != t.Context() || pid != project.ID || id != current.ID || accessCalls != 1 {
					t.Fatal("property Task read preceded its scoped access")
				}
				return current, nil
			}}
			scope := &taskSnapshotScopeMock{taskMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectReader { return projects }, TaskDAOFn: func() store.TaskReader { return reader }}
			database := &taskStoreMock{taskMockBase: base.withLabel("store"), ReadSnapshotFn: func(ctx context.Context, work func(store.SnapshotScope) error) error {
				scopeCalls++
				if ctx != t.Context() {
					t.Fatal("property snapshot changed context")
				}
				return work(scope)
			}}
			actual, err := taskservice.NewTasks(database).Get(t.Context(), principal, project.ID, target.ID)
			if err != nil || !reflect.DeepEqual(actual, current) || scopeCalls != 1 || taskCalls != 1 || accessCalls != 1 {
				t.Fatalf("property snapshot mixed its row: %#v %v", actual, err)
			}
		})
	}
	if !reflect.DeepEqual(target.Properties, model.TaskProperties{}) {
		t.Fatal("property candidates mutated their source model")
	}
}
