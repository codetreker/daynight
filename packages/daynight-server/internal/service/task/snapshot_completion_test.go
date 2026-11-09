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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func taskSnapshotCompletionFailure() *store.TransactionError {
	return &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
}

func requireTaskSnapshotCompletion(t *testing.T, result any, err error, failure *store.TransactionError) {
	t.Helper()
	var transaction *store.TransactionError
	var fault *model.Fault
	if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !errors.As(err, &transaction) || transaction != failure || !transaction.CommitAttempted || transaction.Outcome != store.TransactionUnknown || errors.As(err, &fault) || !reflect.DeepEqual(result, reflect.Zero(reflect.TypeOf(result)).Interface()) {
		t.Fatalf("snapshot completion exposed a refusal or partial result: %#v, %v", result, err)
	}
}

func TestTaskReadsRetainCompletionOverStagedRefusals(t *testing.T) {
	for _, method := range []string{"Get", "List", "Graph", "Sync", "Assignees"} {
		t.Run(method, func(t *testing.T) {
			f := newTaskReadFixture(t)
			_, target, _ := taskMockModels()
			want := []string{"read store.ReadSnapshot", "snapshot.ProjectDAO", "project reader.ProjectAccess"}
			if method == "Get" {
				f.reader.TaskFn = func(ctx context.Context, project, id string) (model.Task, error) {
					f.requireProject(ctx, project)
					if id != target.ID {
						t.Fatal("missing Task identity changed")
					}
					return model.Task{}, model.ErrNotFound
				}
				want = append(want, "snapshot.TaskDAO", "task reader.Task")
			} else {
				f.projectReader.ProjectAccessFn = func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
					f.requireProject(ctx, id)
					if principal != f.principal {
						t.Fatal("missing Project principal changed")
					}
					return model.ProjectAccess{}, model.ErrNotFound
				}
			}
			invoke := func() (any, error) {
				tasks := taskservice.NewTasks(f.store)
				switch method {
				case "Get":
					return tasks.Get(f.ctx, f.principal, f.project.ID, target.ID)
				case "List":
					return tasks.List(f.ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}})
				case "Graph":
					return tasks.Graph(f.ctx, f.principal, f.project.ID, target.ID)
				case "Sync":
					return taskservice.NewTaskSync(f.store, taskReadSessionStates{t: t, ctx: f.ctx}, 10*time.Second).Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
				default:
					return tasks.Assignees(f.ctx, f.principal, f.project.ID, taskservice.TaskAssigneesRequest{})
				}
			}
			_, baseline := invoke()
			requireFault(t, baseline, "not_found")
			if f.reads != 1 || !slices.Equal(f.base.trace.snapshot(), want) {
				t.Fatalf("baseline read calls: %v", f.base.trace.snapshot())
			}
			failure := taskSnapshotCompletionFailure()
			read := f.store.ReadSnapshotFn
			f.store.ReadSnapshotFn = func(ctx context.Context, work func(store.SnapshotScope) error) error {
				if err := read(ctx, work); err != nil {
					t.Fatalf("staged refusal escaped callback: %v", err)
				}
				return failure
			}
			result, err := invoke()
			requireTaskSnapshotCompletion(t, result, err, failure)
			if f.reads != 2 || !slices.Equal(f.base.trace.snapshot(), append(append([]string{}, want...), want...)) {
				t.Fatalf("completion read calls: %v", f.base.trace.snapshot())
			}
		})
	}
}

func TestThreadReadDiscardsSuccessfulPageAfterCompletionFailure(t *testing.T) {
	f := newThreadFailureFixture(t)
	var stages []string
	f.call = func(_ context.Context, stage string) error { stages = append(stages, stage); return nil }
	baseline, err := f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
	if err != nil || len(baseline.Page.Items) != 1 || baseline.JSON == nil {
		t.Fatalf("baseline Thread page: %#v, %v", baseline, err)
	}
	want := []string{"read-credential", "read-authorization", "read-presence", "read-candidates", "read-sides"}
	if !slices.Equal(stages, want) {
		t.Fatalf("baseline Thread calls: %v", stages)
	}
	failure := taskSnapshotCompletionFailure()
	read := f.database.ReadSnapshotFn
	f.database.ReadSnapshotFn = func(ctx context.Context, work func(store.SnapshotScope) error) error {
		if err := read(ctx, work); err != nil {
			t.Fatalf("successful Thread callback failed: %v", err)
		}
		return failure
	}
	result, err := f.service.List(t.Context(), f.principal, f.project.ID, f.task.ID, taskservice.ThreadListRequest{})
	requireTaskSnapshotCompletion(t, result, err, failure)
	if !slices.Equal(stages, append(append([]string{}, want...), want...)) {
		t.Fatalf("completion Thread calls: %v", stages)
	}
}

func TestTaskWriteCompletionDominatesStagedDomainResults(t *testing.T) {
	for _, name := range []string{"missing task update", "stale version update", "missing task status", "stale version status", "same-state status", "invalid dependency create"} {
		t.Run(name, func(t *testing.T) {
			for _, failed := range []bool{false, true} {
				f := newTaskFailureFixture(t, t.Context(), store.TransactionCommitted)
				before := f.target
				missing := "00000000-0000-0000-0000-000000000000"
				if name == "invalid dependency create" {
					f.tasks.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
						if ctx != f.ctx || !slices.Equal(ids, []string{missing}) {
							t.Fatal("missing dependency lookup changed")
						}
						return []model.Task{}, nil
					}
				} else if name == "missing task update" || name == "missing task status" {
					f.tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
						if ctx != f.ctx || id != missing {
							t.Fatal("missing Task lookup changed")
						}
						return model.Task{}, model.ErrNotFound
					}
				} else {
					f.expectTask(t, f.target)
				}
				failure := taskSnapshotCompletionFailure()
				write := f.database.WriteProjectFn
				f.database.WriteProjectFn = func(ctx context.Context, project string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
					completion, err := write(ctx, project, work)
					if err != nil {
						t.Fatalf("staged Task result escaped callback: %v", err)
					}
					if failed {
						return store.Completion{Outcome: store.TransactionUnknown}, failure
					}
					return completion, nil
				}
				tasks := taskservice.NewTasks(f.database)
				var result model.Task
				var err error
				switch name {
				case "missing task update":
					result, err = tasks.Update(f.ctx, f.principal, f.project.ID, missing, taskcore.UpdateTask{Version: 1, Title: pointer("Rejected")})
				case "stale version update":
					result, err = tasks.Update(f.ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version + 1, Title: pointer("Rejected")})
				case "missing task status":
					result, err = tasks.SetStatus(f.ctx, f.principal, f.project.ID, missing, taskcore.SetTaskStatus{Version: 1, Status: model.TaskInProgress})
				case "stale version status":
					result, err = tasks.SetStatus(f.ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version + 1, Status: model.TaskTodo})
				case "same-state status":
					result, err = tasks.SetStatus(f.ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: f.target.Status})
				default:
					result, err = tasks.Create(f.ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Rejected", DependsOn: []string{missing}})
				}
				if failed {
					requireTaskSnapshotCompletion(t, result, err, failure)
				} else if name == "same-state status" {
					if err != nil || !reflect.DeepEqual(result, before) {
						t.Fatalf("baseline no-op changed: %#v %v", result, err)
					}
				} else {
					var fault *model.Fault
					if !errors.As(err, &fault) || !reflect.DeepEqual(result, model.Task{}) {
						t.Fatalf("baseline refusal lost: %#v %v", result, err)
					}
				}
				if !reflect.DeepEqual(f.target, before) {
					t.Fatal("Task completion mutated its supplied input")
				}
				want := map[string]int{"store.WriteProject": 1, "projects.ProjectAccess": 1, "tasks.Task": 1}
				if name == "invalid dependency create" {
					delete(want, "tasks.Task")
					want["tasks.TasksByID"] = 1
				}
				for method, count := range want {
					actual := 0
					for _, call := range f.database.trace.snapshot() {
						if call == method {
							actual++
						}
					}
					if actual != count {
						t.Fatalf("%s calls: got %d want %d", method, actual, count)
					}
				}
			}
		})
	}
}

func TestGraphReadErrorsAndCompletionNeverReturnPartialGraph(t *testing.T) {
	for _, stage := range []string{"project", "projection", "clock", "commit"} {
		t.Run(stage, func(t *testing.T) {
			f := newTaskReadFixture(t)
			root := taskReadID(1)
			tasks := f.graph(root, store.TaskPresence{Found: true}, []model.GraphTask{taskReadGraphTask(root, "Root", model.TaskTodo)})
			failure := error(context.Canceled)
			if stage == "commit" {
				failure = taskSnapshotCompletionFailure()
			}
			switch stage {
			case "project":
				f.projectReader.ProjectFn = func(ctx context.Context, id string) (model.Project, error) {
					f.requireProject(ctx, id)
					return model.Project{}, failure
				}
			case "projection":
				f.reader.TaskGraphTasksFn = func(ctx context.Context, project, id string, selection store.TaskGraphSelection, characters int) ([]model.GraphTask, error) {
					f.requireProject(ctx, project)
					if id != root || selection != (store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}) || characters != projection.TitlePreviewCharacters {
						t.Fatal("failed graph selection changed")
					}
					return nil, failure
				}
			case "clock":
				f.snapshot.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
					f.requireProject(ctx, f.project.ID)
					return time.Time{}, failure
				}
			default:
				read := f.store.ReadSnapshotFn
				f.store.ReadSnapshotFn = func(ctx context.Context, work func(store.SnapshotScope) error) error {
					if err := read(ctx, work); err != nil {
						t.Fatalf("graph callback failed: %v", err)
					}
					return failure
				}
			}
			result, err := tasks.Graph(f.ctx, f.principal, f.project.ID, root)
			var fault *model.Fault
			if !errors.Is(err, context.Canceled) || errors.As(err, &fault) || !reflect.DeepEqual(result, model.TaskGraph{}) || f.reads != 1 {
				t.Fatalf("graph failure exposed partial data: %#v %v", result, err)
			}
			if stage == "commit" {
				requireTaskSnapshotCompletion(t, result, err, failure.(*store.TransactionError))
			}
			want := []string{"read store.ReadSnapshot", "snapshot.ProjectDAO", "project reader.ProjectAccess", "snapshot.ProjectDAO", "project reader.Project", "snapshot.TaskDAO", "task reader.TaskPresence", "task reader.TaskGraphTasks", "snapshot.ObservedAt"}
			if stage == "project" {
				want = want[:5]
			}
			if stage == "projection" {
				want = want[:8]
			}
			if !slices.Equal(f.base.trace.snapshot(), want) {
				t.Fatalf("failed Graph calls: %v, want %v", f.base.trace.snapshot(), want)
			}
		})
	}
}

func TestTaskSyncCompletionDiscardsConstructedResult(t *testing.T) {
	f := newTaskReadFixture(t)
	epoch := taskReadID(90)
	row := taskReadView(taskReadID(1), "Property read", 1, f.observed)
	sync := f.sync(epoch, func(lower *time.Time) ([]model.TaskViewRecord, error) {
		if lower != nil {
			t.Fatal("normal snapshot acquired an incremental lower bound")
		}
		return []model.TaskViewRecord{row}, nil
	}, []model.TaskAssigneeFact{}, 10*time.Second)
	baseline, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
	if err != nil || len(baseline.Tasks) != 1 || baseline.Tasks[0].ID != row.ID || baseline.Sessions == nil || f.reads != 1 {
		t.Fatalf("baseline Task sync: %#v %v", baseline, err)
	}
	want := []string{"read store.ReadSnapshot", "snapshot.ProjectDAO", "project reader.ProjectAccess", "snapshot.ProjectDAO", "project reader.Project", "snapshot.TaskDAO", "task reader.TaskCacheEpoch", "task reader.TaskSyncTasks", "task reader.TaskAssignees", "snapshot.ObservedAt", "snapshot.SessionDAO", "Session reader.CurrentTaskSessionSources"}
	if !slices.Equal(f.base.trace.snapshot(), want) {
		t.Fatalf("baseline Task sync calls: %v", f.base.trace.snapshot())
	}
	failure := taskSnapshotCompletionFailure()
	read := f.store.ReadSnapshotFn
	f.store.ReadSnapshotFn = func(ctx context.Context, work func(store.SnapshotScope) error) error {
		if err := read(ctx, work); err != nil {
			t.Fatalf("successful Task sync callback failed: %v", err)
		}
		return failure
	}
	result, err := sync.Get(f.ctx, f.principal, f.project.ID, taskservice.TaskSyncRequest{})
	requireTaskSnapshotCompletion(t, result, err, failure)
	if f.reads != 2 || !slices.Equal(f.base.trace.snapshot(), append(append([]string{}, want...), want...)) {
		t.Fatalf("Task sync snapshot calls: %d, trace: %v", f.reads, f.base.trace.snapshot())
	}
}
