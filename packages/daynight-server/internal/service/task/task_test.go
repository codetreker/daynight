package task_test

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

type taskRuleFixture struct {
	t             *testing.T
	project       model.Project
	target        model.Task
	principal     model.Principal
	tasks         *taskservice.Tasks
	database      *taskStoreMock
	reader        *taskReaderMock
	writer        *taskWriterMock
	projectReader *projectReaderMock
	projectWriter *projectWriterMock
	sessions      *projectSessionMock
	capture       *captureDAOMock
	snapshot      *taskSnapshotScopeMock
	scope         *taskProjectScopeMock
}

func newTaskRuleFixture(t *testing.T) *taskRuleFixture {
	t.Helper()
	project, target, principal := taskMockModels()
	target.AssignedTo = nil
	base := newTaskMockBase(t, "rule")
	fixture := &taskRuleFixture{t: t, project: project, target: target, principal: principal,
		database:      &taskStoreMock{taskMockBase: base.withLabel("store")},
		reader:        &taskReaderMock{taskMockBase: base.withLabel("reader")},
		writer:        &taskWriterMock{taskMockBase: base.withLabel("writer")},
		projectReader: &projectReaderMock{taskMockBase: base.withLabel("project-reader")},
		projectWriter: &projectWriterMock{taskMockBase: base.withLabel("project-writer")},
		sessions:      &projectSessionMock{taskMockBase: base.withLabel("sessions")},
		capture:       &captureDAOMock{taskMockBase: base.withLabel("capture")},
	}
	fixture.projectReader.ProjectAccessFn = func(_ context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		if actor != principal || id != project.ID {
			t.Fatalf("read authorization changed: %#v %s", actor, id)
		}
		return taskMockAccess(project, principal), nil
	}
	fixture.projectWriter.ProjectAccessFn = func(_ context.Context, actor model.Principal) (model.ProjectAccess, error) {
		if actor != principal {
			t.Fatalf("write authorization changed: %#v", actor)
		}
		return taskMockAccess(project, principal), nil
	}
	fixture.snapshot = &taskSnapshotScopeMock{taskMockBase: base.withLabel("snapshot"),
		ProjectDAOFn: func() store.ProjectReader { return fixture.projectReader },
		TaskDAOFn:    func() store.TaskReader { return fixture.reader },
	}
	fixture.scope = &taskProjectScopeMock{taskMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return fixture.projectWriter },
		TaskDAOFn:    func() store.TaskWriteDAO { return fixture.writer },
		SessionDAOFn: func() store.ProjectSessionDAO { return fixture.sessions },
		CaptureDAOFn: func() store.WebhookCaptureDAO { return fixture.capture },
	}
	fixture.tasks = taskservice.NewTasks(fixture.database)
	return fixture
}

func (fixture *taskRuleFixture) read(ctx context.Context) {
	fixture.database.ReadSnapshotFn = func(actual context.Context, work func(store.SnapshotScope) error) error {
		if actual != ctx || work == nil {
			fixture.t.Fatal("snapshot changed context or callback")
		}
		before := len(fixture.database.trace.snapshot())
		err := work(fixture.snapshot)
		fixture.requireAuthorization(before, "project-reader.ProjectAccess")
		return err
	}
}

func (fixture *taskRuleFixture) requireAuthorization(before int, method string) {
	fixture.t.Helper()
	calls := 0
	for _, call := range fixture.database.trace.snapshot()[before:] {
		if call == method {
			calls++
		}
	}
	if calls != 1 {
		fixture.t.Errorf("authorization calls=%d want1 in the same scope", calls)
	}
}

func (fixture *taskRuleFixture) write(ctx context.Context, completion store.Completion) {
	fixture.database.WriteProjectFn = func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		if actual != ctx || id != fixture.project.ID || work == nil {
			fixture.t.Fatal("write changed context, Project identity, or callback")
		}
		before := len(fixture.database.trace.snapshot())
		err := work(fixture.scope)
		fixture.requireAuthorization(before, "project-writer.ProjectAccess")
		return completion, err
	}
}

func (fixture *taskRuleFixture) current(ctx context.Context, current model.Task) {
	fixture.writer.TaskFn = func(actual context.Context, id string) (model.Task, error) {
		if actual != ctx || id != current.ID {
			fixture.t.Fatal("current Task read changed context or identity")
		}
		return current, nil
	}
}

func (fixture *taskRuleFixture) dependencies(ctx context.Context, ids []string, tasks []model.Task) {
	fixture.writer.TasksByIDFn = func(actual context.Context, requested []string) ([]model.Task, error) {
		if actual != ctx || !slices.Equal(requested, ids) {
			fixture.t.Fatalf("dependency query: %v want %v", requested, ids)
		}
		return slices.Clone(tasks), nil
	}
}

func (fixture *taskRuleFixture) noCycles(ctx context.Context, id string, ids []string) {
	fixture.writer.ReachableFn = func(actual context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
		if actual != ctx || !slices.Contains(ids, from) || to != id || replacement.TaskID != id || !slices.Equal(replacement.DependsOn, ids) {
			fixture.t.Fatalf("reachability changed candidate: from=%s to=%s replacement=%#v", from, to, replacement)
		}
		return false, nil
	}
}

func (fixture *taskRuleFixture) update(ctx context.Context, id string, values store.TaskWrite, result model.Task) {
	calls := 0
	fixture.writer.UpdateTaskFn = func(actual context.Context, actualID string, actualValues store.TaskWrite) (model.Task, error) {
		calls++
		if actual != ctx || actualID != id || !reflect.DeepEqual(actualValues, values) {
			fixture.t.Fatalf("update arguments: %s %#v want %#v", actualID, actualValues, values)
		}
		return result, nil
	}
	fixture.t.Cleanup(func() {
		if calls != 1 {
			fixture.t.Errorf("Task update calls=%d want1", calls)
		}
	})
	fixture.freeze(ctx, id)
}

func (fixture *taskRuleFixture) freeze(ctx context.Context, id string) {
	fixture.sessions.DrainTaskSessionsFn = func(actual context.Context, actualID string, input store.TaskSessionDrain) error {
		if actual != ctx || actualID != id || input.ActiveClaim != nil || input.SourceLifecycle != "active" || input.GraceSeconds != 60 {
			fixture.t.Fatalf("session drain changed task/claim: %s %#v", actualID, input)
		}
		return nil
	}
	fixture.sessions.TransitionTaskSessionReceiptsFn = func(actual context.Context, actualID string, input store.TaskSessionReceiptTransition) error {
		if actual != ctx || actualID != id || input.PreviousState != "accepted" || input.NextState != "rejected" {
			fixture.t.Fatal("receipt freeze changed task or transition")
		}
		return nil
	}
}

func (fixture *taskRuleFixture) audience(ctx context.Context, types ...string) {
	fixture.capture.FreezeAudienceFn = func(actual context.Context, id string, actualTypes []string) ([]store.WebhookAudience, error) {
		if actual != ctx || id != fixture.project.ID || !slices.Equal(actualTypes, types) {
			fixture.t.Fatalf("capture audience types=%v want%v", actualTypes, types)
		}
		return []store.WebhookAudience{}, nil
	}
}

func ruleTask(id, title string) model.Task {
	_, task, _ := taskMockModels()
	task.ID, task.Title, task.AssignedTo = id, title, nil
	return task
}

func TestTaskCreateReadAndDerivedState(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	f.read(ctx)
	f.reader.TasksFn = func(actual context.Context, id string, input store.TaskQuery) (store.TaskPage, error) {
		if actual != ctx || id != f.project.ID || input.Page.Limit != 50 {
			t.Fatal("empty list changed query")
		}
		return store.TaskPage{Items: []model.Task{}}, nil
	}
	empty, err := f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 50}})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty task page: %#v %v", empty, err)
	}
	first := ruleTask("a1111111-1111-4111-8111-111111111111", "First")
	second := ruleTask("b1111111-1111-4111-8111-111111111111", "Second")
	ids := []string{first.ID, second.ID}
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	f.dependencies(ctx, ids, []model.Task{first, second})
	var created model.Task
	f.writer.ReachableFn = func(actual context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
		if actual != ctx || !slices.Contains(ids, from) || replacement.TaskID != to || !slices.Equal(replacement.DependsOn, ids) {
			t.Fatal("created dependency replacement changed")
		}
		return false, nil
	}
	f.writer.CreateTaskFn = func(actual context.Context, id string, values store.TaskWrite) (model.Task, error) {
		if actual != ctx || id == "" || values.Status != model.TaskTodo || values.AllowAgents || values.AssignedTo != nil || values.Title != "  Third  " || values.Description != "Description" || !slices.Equal(values.DependsOn, ids) || values.ExternalDependsOn == nil || values.Properties == nil {
			t.Fatalf("create candidate: %#v", values)
		}
		created = ruleTask(id, values.Title)
		created.Description = "Description"
		created.DependsOn, created.BlockedBy = slices.Clone(ids), slices.Clone(ids)
		created.Ready = false
		return created, nil
	}
	f.audience(ctx, "task.created")
	got, err := f.tasks.Create(ctx, f.principal, strings.ToUpper(f.project.ID), taskcore.CreateTask{Status: pointer(model.TaskTodo), Title: "  Third  ", Description: "Description", DependsOn: []string{strings.ToUpper(second.ID), strings.ToUpper(first.ID)}})
	if err != nil || !reflect.DeepEqual(got, created) {
		t.Fatalf("create authoritative result: %#v %v", got, err)
	}
	f.reader.TaskFn = func(actual context.Context, projectID, id string) (model.Task, error) {
		if actual != ctx || projectID != f.project.ID || id != created.ID {
			t.Fatal("canonical task read changed")
		}
		return created, nil
	}
	got, err = f.tasks.Get(ctx, f.principal, strings.ToUpper(f.project.ID), strings.ToUpper(created.ID))
	if err != nil || !reflect.DeepEqual(got, created) {
		t.Fatalf("canonical read: %#v %v", got, err)
	}
	ready := created
	ready.Ready, ready.BlockedBy = true, []string{}
	f.reader.TaskFn = func(context.Context, string, string) (model.Task, error) { return ready, nil }
	got, err = f.tasks.Get(ctx, f.principal, f.project.ID, created.ID)
	if err != nil || !reflect.DeepEqual(got, ready) || got.Version != created.Version || !got.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("derived read mutated metadata: %#v %v", got, err)
	}
	f.current(ctx, ready)
	started := ready
	started.Status, started.Version, started.Ready = model.TaskInProgress, 2, false
	stamp := ready.UpdatedAt.Add(time.Second)
	started.UpdatedAt, started.StartedAt = stamp, &stamp
	values := store.TaskWrite{Title: ready.Title, Description: ready.Description, Status: model.TaskInProgress, Properties: model.TaskProperties{}, DependsOn: ids, ExternalDependsOn: []string{}}
	f.update(ctx, ready.ID, values, started)
	f.audience(ctx, "task.status_changed")
	got, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, ready.ID, taskcore.SetTaskStatus{Version: ready.Version, Status: model.TaskInProgress})
	if err != nil || !reflect.DeepEqual(got, started) {
		t.Fatalf("start authoritative result: %#v %v", got, err)
	}
}

type taskInputValidationStore struct {
	writeProject func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
}

func (taskInputValidationStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("Task input validation unexpectedly read a snapshot")
}

func (database taskInputValidationStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	if database.writeProject == nil {
		panic("Task input validation unexpectedly entered a Project write")
	}
	return database.writeProject(ctx, id, work)
}

func taskInputValidationFixture() (*taskservice.Tasks, model.Project, model.Task, model.Principal) {
	project := model.Project{ID: "b0000000-0000-4000-8000-000000000004"}
	target := model.Task{ID: "a0000000-0000-4000-8000-000000000003", ProjectID: project.ID, Version: 1, Status: model.TaskTodo, Title: "Target", Properties: model.TaskProperties{}}
	principal := model.Principal{Kind: model.SessionCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}
	return taskservice.NewTasks(taskInputValidationStore{}), project, target, principal
}

func TestTaskValidInputReachesProjectWriter(t *testing.T) {
	for _, method := range []string{"create", "update", "status"} {
		t.Run(method, func(t *testing.T) {
			_, project, target, principal := taskInputValidationFixture()
			ctx := t.Context()
			sentinel := errors.New("Project writer reached")
			calls := 0
			tasks := taskservice.NewTasks(taskInputValidationStore{writeProject: func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				calls++
				if actual != ctx || id != project.ID || work == nil {
					t.Fatal("Task input validation changed writer context, Project identity, or callback")
				}
				return store.Completion{Outcome: store.TransactionNotCommitted}, sentinel
			}})
			var err error
			switch method {
			case "create":
				_, err = tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "Valid"})
			case "update":
				_, err = tasks.Update(ctx, principal, project.ID, target.ID, taskcore.UpdateTask{Version: target.Version, Title: pointer("Changed")})
			case "status":
				_, err = tasks.SetStatus(ctx, principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskTodo})
			}
			var refusal *model.Fault
			if calls != 1 || !errors.Is(err, sentinel) || errors.As(err, &refusal) {
				t.Fatalf("valid Task input did not reach the writer once: calls=%d error=%v", calls, err)
			}
		})
	}
}

func TestTaskInputValidation(t *testing.T) {
	tasks, project, target, principal := taskInputValidationFixture()
	for _, input := range []taskcore.CreateTask{
		{Title: ""}, {Title: " \n\u2003"}, {Title: "bad\x00title"}, {Title: "bad\xfftitle"},
		{Title: "Valid", Description: "bad\x00description"}, {Title: "Valid", Description: "bad\xffdescription"},
		{Title: "Valid", DependsOn: []string{"invalid"}}, {Title: "Valid", DependsOn: []string{target.ID, strings.ToUpper(target.ID)}},
	} {
		_, err := tasks.Create(context.Background(), principal, project.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, input := range []taskcore.UpdateTask{
		{Version: 0, Title: pointer("Changed")}, {Version: -1, Title: pointer("Changed")}, {Version: target.Version},
	} {
		_, err := tasks.Update(context.Background(), principal, project.ID, target.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, operation := range []func() error{
		func() error {
			_, err := tasks.Create(context.Background(), principal, "invalid", taskcore.CreateTask{Title: "Valid"})
			return err
		},
		func() error { _, err := tasks.Get(context.Background(), principal, "invalid", target.ID); return err },
		func() error { _, err := tasks.Get(context.Background(), principal, project.ID, "invalid"); return err },
		func() error {
			_, err := tasks.List(context.Background(), principal, "invalid", taskservice.TaskListRequest{})
			return err
		},
		func() error {
			_, err := tasks.Update(context.Background(), principal, "invalid", target.ID, taskcore.UpdateTask{})
			return err
		},
		func() error {
			_, err := tasks.Update(context.Background(), principal, project.ID, "invalid", taskcore.UpdateTask{})
			return err
		},
	} {
		requireFault(t, operation(), "invalid_input")
	}
	sentinel := errors.New("entropy unavailable")
	uuid.SetRand(entropyFailure{sentinel})
	t.Cleanup(func() { uuid.SetRand(rand.Reader) })
	_, err := tasks.Create(context.Background(), principal, project.ID, taskcore.CreateTask{Title: "Valid"})
	var fault *model.Fault
	if !errors.Is(err, sentinel) || errors.As(err, &fault) {
		t.Fatalf("task ID entropy error must retain cause: %v", err)
	}
}

func TestTaskScopeAndDependencyReferences(t *testing.T) {
	for _, operation := range []string{"get foreign", "get missing", "get missing project", "list missing project", "create missing project", "update missing project", "update foreign"} {
		t.Run(operation, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			foreign := "00000000-0000-4000-8000-000000000088"
			missing := "00000000-0000-0000-0000-000000000000"
			f.read(ctx)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.reader.TaskFn = func(context.Context, string, string) (model.Task, error) { return model.Task{}, model.ErrNotFound }
			f.writer.TaskFn = func(context.Context, string) (model.Task, error) { return model.Task{}, model.ErrNotFound }
			if strings.Contains(operation, "missing project") {
				f.projectReader.ProjectAccessFn = func(_ context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
					if actor != f.principal || id != missing {
						t.Fatal("wrong missing Project authorization")
					}
					return model.ProjectAccess{}, model.ErrNotFound
				}
				f.database.WriteProjectFn = func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
					if actual != ctx || id != missing || work == nil {
						t.Fatal("missing writer scope changed")
					}
					return store.Completion{Outcome: store.TransactionNotCommitted}, model.ErrNotFound
				}
			}
			var err error
			switch operation {
			case "get foreign":
				_, err = f.tasks.Get(ctx, f.principal, f.project.ID, foreign)
			case "get missing":
				_, err = f.tasks.Get(ctx, f.principal, f.project.ID, missing)
			case "get missing project":
				_, err = f.tasks.Get(ctx, f.principal, missing, f.target.ID)
			case "list missing project":
				_, err = f.tasks.List(ctx, f.principal, missing, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
			case "create missing project":
				_, err = f.tasks.Create(ctx, f.principal, missing, taskcore.CreateTask{Title: "Missing project"})
			case "update missing project":
				_, err = f.tasks.Update(ctx, f.principal, missing, f.target.ID, taskcore.UpdateTask{Version: 1, Title: pointer("Changed")})
			case "update foreign":
				_, err = f.tasks.Update(ctx, f.principal, f.project.ID, foreign, taskcore.UpdateTask{Version: 1, Title: pointer("Changed")})
			}
			fault := requireFault(t, err, "not_found")
			if !errors.Is(fault, model.ErrNotFound) {
				t.Fatalf("missing cause: %#v", fault)
			}
		})
	}
	for _, method := range []string{"create", "update"} {
		t.Run(method+" references", func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			refs := []string{"00000000-0000-0000-0000-000000000000", "00000000-0000-4000-8000-000000000088"}
			f.dependencies(ctx, refs, []model.Task{})
			f.current(ctx, f.target)
			var err error
			if method == "create" {
				_, err = f.tasks.Create(ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Invalid refs", DependsOn: refs})
			} else {
				_, err = f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: 1, DependsOn: &refs})
			}
			fault := requireFault(t, err, "invalid_input")
			if !slices.Equal(fault.TaskIDs, refs) {
				t.Fatalf("scope-safe reference IDs: %v", fault.TaskIDs)
			}
		})
	}
}

func TestTaskCyclesAndDependencyReplacement(t *testing.T) {
	for _, cycle := range []bool{true, false} {
		for _, dependency := range []string{"a1111111-1111-4111-8111-111111111111", "b1111111-1111-4111-8111-111111111111"} {
			t.Run(fmt.Sprintf("cycle=%t_%s", cycle, dependency), func(t *testing.T) {
				f := newTaskRuleFixture(t)
				ctx := t.Context()
				f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
				f.current(ctx, f.target)
				ids := []string{dependency}
				f.dependencies(ctx, ids, []model.Task{ruleTask(dependency, "Dependency")})
				f.writer.ReachableFn = func(actual context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
					if actual != ctx || from != dependency || to != f.target.ID || replacement.TaskID != f.target.ID || !slices.Equal(replacement.DependsOn, ids) {
						t.Fatal("replacement graph scope changed")
					}
					return cycle, nil
				}
				if !cycle {
					result := f.target
					result.DependsOn, result.BlockedBy = slices.Clone(ids), slices.Clone(ids)
					result.Ready = false
					result.Version++
					result.UpdatedAt = result.UpdatedAt.Add(time.Second)
					f.update(ctx, f.target.ID, store.TaskWrite{Title: f.target.Title, Properties: model.TaskProperties{}, Status: model.TaskTodo, DependsOn: ids, ExternalDependsOn: []string{}}, result)
				}
				got, err := f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: 1, DependsOn: &ids})
				if cycle {
					fault := requireFault(t, err, "dependency_cycle")
					if !slices.Equal(fault.TaskIDs, ids) {
						t.Fatalf("cycle details: %v", fault.TaskIDs)
					}
				} else if err != nil || !slices.Equal(got.DependsOn, ids) {
					t.Fatalf("replacement result: %#v %v", got, err)
				}
			})
		}
	}
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.DependsOn = []string{"a1111111-1111-4111-8111-111111111111"}
	f.current(ctx, current)
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	f.dependencies(ctx, []string{}, []model.Task{})
	result := f.target
	result.Version++
	result.UpdatedAt = result.UpdatedAt.Add(time.Second)
	f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Properties: model.TaskProperties{}, Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}}, result)
	got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: 1, DependsOn: pointer([]string{})})
	if err != nil || len(got.DependsOn) != 0 {
		t.Fatalf("old edges not replaced: %#v %v", got, err)
	}
}

func TestTaskSetStatusAllPairsAndVersionOrder(t *testing.T) {
	for _, from := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				f := newTaskRuleFixture(t)
				ctx := t.Context()
				current := f.target
				current.Status, current.AllowAgents, current.Description = from, true, "Keep description"
				current.DependsOn, current.ExternalDependsOn = []string{"a1111111-1111-4111-8111-111111111111"}, []string{"a1111111-1111-4111-8111-111111111111"}
				current.BlockedBy, current.Ready = []string{}, from == model.TaskTodo
				if from != model.TaskTodo {
					current.StartedAt = pointer(current.CreatedAt)
				}
				if from == model.TaskDone {
					current.CompletedAt = pointer(current.UpdatedAt)
				}
				current.Properties = model.TaskProperties{"pullRequests": []byte(`[{"url":"https://example.com/pr/1","title":"Keep evidence"}]`)}
				f.current(ctx, current)
				f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
				_, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version + 1, Status: to})
				requireFault(t, err, "version_conflict")
				expected := current
				if from != to {
					expected.Status, expected.Version, expected.UpdatedAt, expected.Ready = to, current.Version+1, current.UpdatedAt.Add(time.Second), to == model.TaskTodo
					if to == model.TaskTodo {
						expected.StartedAt, expected.CompletedAt = nil, nil
					}
					if to == model.TaskInProgress {
						expected.StartedAt, expected.CompletedAt = &expected.UpdatedAt, nil
					}
					if to == model.TaskDone {
						expected.CompletedAt = &expected.UpdatedAt
					}
					if from == model.TaskDone && to != model.TaskDone {
						f.writer.ActiveDependentIDsFn = func(actual context.Context, id string) ([]string, error) {
							if actual != ctx || id != current.ID {
								t.Fatal("dependent admission scope changed")
							}
							return []string{}, nil
						}
					}
					f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Description: current.Description, AllowAgents: true, Properties: current.Properties, Status: to, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn}, expected)
					f.audience(ctx, "task.status_changed")
				}
				got, err := f.tasks.SetStatus(ctx, f.principal, strings.ToUpper(f.project.ID), strings.ToUpper(current.ID), taskcore.SetTaskStatus{Version: current.Version, Status: to})
				if err != nil || !reflect.DeepEqual(got, expected) {
					t.Fatalf("status result: %#v want %#v err%v", got, expected, err)
				}
				if from != to {
					f.current(ctx, expected)
					f.writer.UpdateTaskFn = nil
					_, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: to})
					requireFault(t, err, "version_conflict")
					got, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: expected.Version, Status: to})
					if err != nil || !reflect.DeepEqual(got, expected) {
						t.Fatalf("same-status mutation: %#v %v", got, err)
					}
				}
			})
		}
	}
}

func TestTaskStatusInputValidation(t *testing.T) {
	tasks, project, target, principal := taskInputValidationFixture()
	for _, input := range []taskcore.SetTaskStatus{{Version: 0, Status: model.TaskTodo}, {Version: -1, Status: model.TaskDone}, {Version: 1, Status: ""}, {Version: 1, Status: "invalid"}, {Version: 1, Status: "TODO"}, {Version: 1, Status: " todo"}} {
		_, err := tasks.SetStatus(t.Context(), principal, project.ID, target.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, scope := range [][2]string{{"invalid", target.ID}, {project.ID, "invalid"}} {
		_, err := tasks.SetStatus(t.Context(), principal, scope[0], scope[1], taskcore.SetTaskStatus{Version: 1, Status: model.TaskTodo})
		requireFault(t, err, "invalid_input")
	}
}

func TestTaskSetStatusValidationAndScope(t *testing.T) {
	for _, input := range []taskcore.UpdateTask{{Version: 1, Title: pointer(" ")}, {Version: 1, Description: pointer("bad\x00")}, {Version: 1, DependsOn: pointer([]string{"55555555-5555-4555-8555-555555555555"})}} {
		f := newTaskRuleFixture(t)
		ctx := t.Context()
		f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
		f.current(ctx, f.target)
		_, err := f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, scope := range []string{"project", "missing task", "foreign task"} {
		t.Run(scope, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			missing := "00000000-0000-0000-0000-000000000000"
			projectID, taskID := f.project.ID, missing
			if scope == "project" {
				projectID, taskID = missing, f.target.ID
				f.database.WriteProjectFn = func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
					return store.Completion{Outcome: store.TransactionNotCommitted}, model.ErrNotFound
				}
			} else {
				f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
				if scope == "foreign task" {
					taskID = "a1111111-1111-4111-8111-111111111111"
				}
				f.writer.TaskFn = func(actual context.Context, id string) (model.Task, error) {
					if actual != ctx || id != taskID {
						t.Fatal("missing task identity changed")
					}
					return model.Task{}, model.ErrNotFound
				}
			}
			_, err := f.tasks.SetStatus(ctx, f.principal, projectID, taskID, taskcore.SetTaskStatus{Version: 1, Status: model.TaskTodo})
			fault := requireFault(t, err, "not_found")
			if !errors.Is(fault, model.ErrNotFound) {
				t.Fatal("missing cause lost")
			}
		})
	}
}

func TestTaskSameStatusUsesCurrentDerivedStateAndExactLargeVersion(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.Version = 9007199254740993
	current.DependsOn = []string{"a1111111-1111-4111-8111-111111111111"}
	current.Ready = true
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	f.current(ctx, current)
	got, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskTodo})
	if err != nil || !reflect.DeepEqual(got, current) {
		t.Fatalf("same status lost current derived state: %#v %v", got, err)
	}
	changed := current
	changed.Status, changed.Version, changed.Ready = model.TaskInProgress, current.Version+1, false
	changed.UpdatedAt = changed.UpdatedAt.Add(time.Second)
	changed.StartedAt = &changed.UpdatedAt
	f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Properties: current.Properties, Status: model.TaskInProgress, DependsOn: current.DependsOn, ExternalDependsOn: []string{}}, changed)
	f.audience(ctx, "task.status_changed")
	got, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskInProgress})
	if err != nil || !reflect.DeepEqual(got, changed) {
		t.Fatalf("large version result: %#v %v", got, err)
	}
	f.current(ctx, changed)
	f.writer.UpdateTaskFn = nil
	_, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskInProgress})
	requireFault(t, err, "version_conflict")
}

func TestTaskSetStatusDependencyProtectionAndNoCascade(t *testing.T) {
	for _, active := range []bool{false, true} {
		for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress} {
			t.Run(fmt.Sprintf("active-dependent=%t_to=%s", active, to), func(t *testing.T) {
				f := newTaskRuleFixture(t)
				ctx := t.Context()
				current := f.target
				current.Status = model.TaskDone
				f.current(ctx, current)
				f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
				successor := "a1111111-1111-4111-8111-111111111111"
				f.writer.ActiveDependentIDsFn = func(actual context.Context, id string) ([]string, error) {
					if actual != ctx || id != current.ID {
						t.Fatal("active dependent query changed")
					}
					if active {
						return []string{successor}, nil
					}
					return []string{}, nil
				}
				expected := current
				if !active {
					expected.Status, expected.Version, expected.Ready = to, 2, to == model.TaskTodo
					expected.UpdatedAt = expected.UpdatedAt.Add(time.Second)
					if to == model.TaskInProgress {
						expected.StartedAt = &expected.UpdatedAt
					}
					f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Status: to, Properties: current.Properties, DependsOn: []string{}, ExternalDependsOn: []string{}}, expected)
					f.audience(ctx, "task.status_changed")
				}
				got, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: 1, Status: to})
				if active {
					fault := requireFault(t, err, "dependency_unsatisfied")
					if !slices.Equal(fault.TaskIDs, []string{successor}) {
						t.Fatal("dependent IDs lost")
					}
				} else if err != nil || !reflect.DeepEqual(got, expected) {
					t.Fatalf("todo successor blocked reopen: %#v %v", got, err)
				}
			})
		}
	}
}

func TestTaskVersionAndSemanticNoop(t *testing.T) {
	a := ruleTask("a1111111-1111-4111-8111-111111111111", "A")
	b := ruleTask("b1111111-1111-4111-8111-111111111111", "B")
	ids := []string{a.ID, b.ID}
	for _, input := range []taskcore.UpdateTask{{Version: 1, Title: pointer("Task")}, {Version: 1, Description: pointer("")}, {Version: 1, DependsOn: pointer([]string{strings.ToUpper(b.ID), strings.ToUpper(a.ID)})}} {
		f := newTaskRuleFixture(t)
		ctx := t.Context()
		current := f.target
		current.DependsOn, current.BlockedBy, current.Ready = ids, ids, false
		f.current(ctx, current)
		f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
		f.dependencies(ctx, ids, []model.Task{a, b})
		f.noCycles(ctx, current.ID, ids)
		got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, input)
		if err != nil || !reflect.DeepEqual(got, current) {
			t.Fatalf("semantic noop: %#v %v", got, err)
		}
	}
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.DependsOn, current.BlockedBy, current.Ready = ids, ids, false
	f.current(ctx, current)
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	f.dependencies(ctx, []string{}, []model.Task{})
	changed := f.target
	changed.Title, changed.Description, changed.Version = "Changed", "New", 2
	changed.UpdatedAt = changed.UpdatedAt.Add(time.Second)
	f.update(ctx, current.ID, store.TaskWrite{Title: "Changed", Description: "New", Properties: model.TaskProperties{}, Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}}, changed)
	got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: 1, Title: pointer("Changed"), Description: pointer("New"), DependsOn: pointer([]string{})})
	if err != nil || !reflect.DeepEqual(got, changed) {
		t.Fatalf("combined update: %#v %v", got, err)
	}
	f.current(ctx, changed)
	f.writer.UpdateTaskFn = nil
	_, err = f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: 1, Title: pointer(changed.Title)})
	requireFault(t, err, "version_conflict")
	cleared := changed
	cleared.Description, cleared.Version = "", 3
	cleared.UpdatedAt = cleared.UpdatedAt.Add(time.Second)
	f.update(ctx, current.ID, store.TaskWrite{Title: "Changed", Properties: model.TaskProperties{}, Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}}, cleared)
	got, err = f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: 2, Description: pointer("")})
	if err != nil || !reflect.DeepEqual(got, cleared) {
		t.Fatalf("clear description: %#v %v", got, err)
	}
}

func TestTaskCandidateDependencyRules(t *testing.T) {
	undone := ruleTask("a1111111-1111-4111-8111-111111111111", "Undone")
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		t.Run(string(status), func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			current := f.target
			current.Status = status
			current.DependsOn, current.BlockedBy, current.Ready = []string{undone.ID}, []string{undone.ID}, false
			f.current(ctx, current)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.dependencies(ctx, current.DependsOn, []model.Task{undone})
			f.noCycles(ctx, current.ID, current.DependsOn)
			if status == model.TaskTodo {
				result := current
				result.Title, result.Description, result.Version = "Edited todo", "Unfinished prerequisites allowed", 2
				result.UpdatedAt = result.UpdatedAt.Add(time.Second)
				f.update(ctx, current.ID, store.TaskWrite{Title: result.Title, Description: result.Description, Properties: current.Properties, Status: status, DependsOn: current.DependsOn, ExternalDependsOn: []string{}}, result)
			}
			got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: 1, Title: pointer("Edited todo"), Description: pointer("Unfinished prerequisites allowed")})
			if status == model.TaskTodo {
				if err != nil || got.Status != model.TaskTodo || got.Ready {
					t.Fatalf("metadata changed status/readiness: %#v %v", got, err)
				}
				current = got
				f.current(ctx, current)
			} else {
				fault := requireFault(t, err, "dependency_unsatisfied")
				if !slices.Equal(fault.TaskIDs, []string{undone.ID}) {
					t.Fatal("candidate omitted blocked IDs")
				}
			}
			got, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: model.TaskInProgress})
			if status != model.TaskInProgress {
				requireFault(t, err, "dependency_unsatisfied")
			} else if err != nil || !reflect.DeepEqual(got, current) {
				t.Fatalf("same-status request changed blocked metadata: %#v %v", got, err)
			}
			if status == model.TaskInProgress {
				_, err = f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
				requireFault(t, err, "dependency_unsatisfied")
			}
		})
	}
}

func TestTaskListKeysetsFiltersAndCursorScopes(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	f.read(ctx)
	first := ruleTask("a1111111-1111-4111-8111-111111111111", "First")
	second := ruleTask("b1111111-1111-4111-8111-111111111111", "Second")
	third := ruleTask("c1111111-1111-4111-8111-111111111111", "Third")
	expectedPages := []struct {
		after *store.Position
		limit int
		items []model.Task
		more  bool
	}{{nil, 2, []model.Task{first, second}, true}, {&store.Position{ID: second.ID, CreatedAt: second.CreatedAt}, 1, []model.Task{third}, false}}
	calls := 0
	f.reader.TasksFn = func(actual context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
		if calls >= len(expectedPages) {
			t.Fatal("extra page query")
		}
		want := expectedPages[calls]
		calls++
		if actual != ctx || id != f.project.ID || q.Page.Limit != want.limit || !reflect.DeepEqual(q.Page.After, want.after) {
			t.Fatalf("keyset query: %#v want %#v", q, want)
		}
		return store.TaskPage{Items: want.items, HasMore: want.more}, nil
	}
	page, err := f.tasks.List(ctx, f.principal, strings.ToUpper(f.project.ID), taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 2}})
	if err != nil || len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("first keyset page: %#v %v", page, err)
	}
	firstCursor := page.NextCursor
	final, err := f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1, Cursor: firstCursor}})
	if err != nil || len(final.Items) != 1 || final.Items[0].ID != third.ID || final.NextCursor != nil || calls != 2 {
		t.Fatalf("final keyset page: %#v %v calls%d", final, err, calls)
	}
	for _, input := range []struct {
		status *model.TaskStatus
		ready  *bool
	}{{nil, pointer(true)}, {nil, pointer(false)}, {pointer(model.TaskTodo), nil}, {pointer(model.TaskTodo), pointer(false)}, {pointer(model.TaskInProgress), nil}, {pointer(model.TaskDone), pointer(true)}} {
		f.reader.TasksFn = func(actual context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
			if actual != ctx || id != f.project.ID || !reflect.DeepEqual(q.Status, input.status) || !reflect.DeepEqual(q.Ready, input.ready) {
				t.Fatalf("filter query changed: %#v", q)
			}
			return store.TaskPage{Items: []model.Task{}}, nil
		}
		got, err := f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, Status: input.status, Ready: input.ready})
		if err != nil || got.Items == nil || got.NextCursor != nil {
			t.Fatalf("filtered empty page: %#v %v", got, err)
		}
	}
	for _, request := range []taskservice.TaskListRequest{{PageRequest: model.PageRequest{Limit: 0}}, {PageRequest: model.PageRequest{Limit: 10}, Status: pointer(model.TaskStatus(""))}, {PageRequest: model.PageRequest{Limit: 10}, Status: pointer(model.TaskStatus("invalid"))}, {PageRequest: model.PageRequest{Limit: 10, Cursor: pointer("")}}, {PageRequest: model.PageRequest{Limit: 10, Cursor: firstCursor}, Status: pointer(model.TaskTodo)}, {PageRequest: model.PageRequest{Limit: 10, Cursor: firstCursor}, Ready: pointer(false)}} {
		_, err := f.tasks.List(ctx, f.principal, f.project.ID, request)
		requireFault(t, err, "invalid_input")
	}
	_, err = f.tasks.List(ctx, f.principal, "00000000-0000-0000-0000-000000000000", taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10, Cursor: firstCursor}})
	requireFault(t, err, "invalid_input")
	projectCursor, err := query.EncodeProjectCursor(f.project, f.principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10, Cursor: &projectCursor}})
	requireFault(t, err, "invalid_input")
}

func TestTaskCursorEncodingFailure(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	f.read(ctx)
	target := f.target
	target.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	f.reader.TasksFn = func(actual context.Context, id string, q store.TaskQuery) (store.TaskPage, error) {
		if actual != ctx || id != f.project.ID || q.Page.Limit != 1 {
			t.Fatal("cursor query changed")
		}
		return store.TaskPage{Items: []model.Task{target}, HasMore: true}, nil
	}
	_, err := f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) || !strings.Contains(err.Error(), "encode task cursor") {
		t.Fatalf("unrepresentable cursor must fail: %v", err)
	}
}

func TestTaskStatusAllPrerequisitesAndUnknownLegacyStart(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(fmt.Sprint(external), func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			current := f.target
			ids := []string{"a1111111-1111-4111-8111-111111111111", "b1111111-1111-4111-8111-111111111111"}
			current.DependsOn, current.BlockedBy, current.Ready = ids, ids, false
			if external {
				current.ExternalDependsOn = slices.Clone(ids)
			}
			f.current(ctx, current)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
				_, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: 1, Status: status})
				fault := requireFault(t, err, "dependency_unsatisfied")
				if !slices.Equal(fault.TaskIDs, ids) {
					t.Fatalf("unsatisfied IDs incomplete: %v", fault.TaskIDs)
				}
			}
			current.Status, current.BlockedBy = model.TaskInProgress, []string{}
			current.StartedAt = nil
			f.current(ctx, current)
			completed := current
			completed.Status, completed.Version, completed.UpdatedAt = model.TaskDone, 2, current.UpdatedAt.Add(time.Second)
			completed.CompletedAt = &completed.UpdatedAt
			f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Status: model.TaskDone, Properties: current.Properties, DependsOn: ids, ExternalDependsOn: current.ExternalDependsOn}, completed)
			f.audience(ctx, "task.status_changed")
			got, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
			if err != nil || !reflect.DeepEqual(got, completed) || got.StartedAt != nil || got.CompletedAt == nil {
				t.Fatalf("completion inferred unknown start: %#v %v", got, err)
			}
		})
	}
}

func TestTaskStatusReopenReturnsAllSortedActiveDependents(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	current.Status = model.TaskDone
	f.current(ctx, current)
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	ids := []string{"a1111111-1111-4111-8111-111111111111", "b1111111-1111-4111-8111-111111111111"}
	f.writer.ActiveDependentIDsFn = func(actual context.Context, id string) ([]string, error) {
		if actual != ctx || id != current.ID {
			t.Fatal("reopen queried another Task")
		}
		return ids, nil
	}
	_, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: 1, Status: model.TaskTodo})
	fault := requireFault(t, err, "dependency_unsatisfied")
	if !slices.Equal(fault.TaskIDs, ids) {
		t.Fatalf("dependent IDs incomplete: %v", fault.TaskIDs)
	}
}
