package service

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
	"github.com/google/uuid"
)

func taskService(t *testing.T) (*Tasks, *store.Store, model.Project, string, model.Principal) {
	t.Helper()
	projects, database, databaseURL, principal := projectService(t)
	project, err := projects.Create(context.Background(), principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Tasks", RepoURL: "git@host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	return NewTasks(database), database, project, databaseURL, principal
}

func createTask(t *testing.T, tasks *Tasks, principal model.Principal, projectID, title string, dependencies ...string) model.Task {
	t.Helper()
	task, err := tasks.Create(context.Background(), principal, projectID, CreateTask{Title: title, DependsOn: dependencies})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func updateTask(t *testing.T, tasks *Tasks, principal model.Principal, task model.Task, input UpdateTask) model.Task {
	t.Helper()
	input.Version = task.Version
	updated, err := tasks.Update(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	return updated
}

func setStatusTask(t *testing.T, tasks *Tasks, principal model.Principal, task model.Task, status model.TaskStatus) model.Task {
	t.Helper()
	result, err := tasks.SetStatus(context.Background(), principal, task.ProjectID, task.ID, SetTaskStatus{Version: task.Version, Status: status})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func startTask(t *testing.T, tasks *Tasks, principal model.Principal, task model.Task) model.Task {
	t.Helper()
	return setStatusTask(t, tasks, principal, task, model.TaskInProgress)
}

func finishTask(t *testing.T, tasks *Tasks, principal model.Principal, task model.Task) model.Task {
	t.Helper()
	return setStatusTask(t, tasks, principal, task, model.TaskDone)
}

func pointer[T any](value T) *T { return &value }

func assertTaskUnchanged(t *testing.T, tasks *Tasks, principal model.Principal, before model.Task) {
	t.Helper()
	after, err := tasks.Get(context.Background(), principal, before.ProjectID, before.ID)
	if err != nil || !reflect.DeepEqual(after, before) {
		t.Fatalf("refused operation changed task: before %#v, after %#v, err %v", before, after, err)
	}
}

func TestTaskCreateReadAndDerivedState(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	empty, err := tasks.List(context.Background(), principal, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 50}})
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.NextCursor != nil {
		t.Fatalf("empty task page: %#v, %v", empty, err)
	}
	first := createTask(t, tasks, principal, project.ID, "First")
	second := createTask(t, tasks, principal, project.ID, "Second")
	dependencies := []string{strings.ToUpper(second.ID), strings.ToUpper(first.ID)}
	created, err := tasks.Create(context.Background(), principal, strings.ToUpper(project.ID), CreateTask{Title: "  Third  ", Description: "Description", DependsOn: dependencies})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{first.ID, second.ID}
	slices.Sort(want)
	if created.Status != model.TaskTodo || created.Version != 1 || created.Title != "  Third  " || created.Description != "Description" || created.Ready ||
		!slices.Equal(created.DependsOn, want) || !slices.Equal(created.BlockedBy, want) || created.CreatedAt.IsZero() || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("created task: %#v", created)
	}
	if first.DependsOn == nil || first.BlockedBy == nil || !first.Ready || first.Description != "" {
		t.Fatalf("task defaults: %#v", first)
	}
	got, err := tasks.Get(context.Background(), principal, strings.ToUpper(project.ID), strings.ToUpper(created.ID))
	if err != nil || !reflect.DeepEqual(got, created) {
		t.Fatalf("canonical read: %#v, %v", got, err)
	}

	first = startTask(t, tasks, principal, first)
	first = finishTask(t, tasks, principal, first)

	second = startTask(t, tasks, principal, second)
	second = finishTask(t, tasks, principal, second)
	ready, err := tasks.Get(context.Background(), principal, project.ID, created.ID)
	if err != nil || !ready.Ready || len(ready.BlockedBy) != 0 || ready.Version != created.Version || !ready.UpdatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("derived readiness must not mutate metadata: %#v, %v", ready, err)
	}
	started := startTask(t, tasks, principal, ready)
	if started.Ready || started.Version != 2 {
		t.Fatalf("active task readiness: %#v", started)
	}
}

func TestTaskInputValidation(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	for _, input := range []CreateTask{
		{Title: ""}, {Title: " \n\u2003"}, {Title: "bad\x00title"}, {Title: "bad\xfftitle"},
		{Title: "Valid", Description: "bad\x00description"}, {Title: "Valid", Description: "bad\xffdescription"},
		{Title: "Valid", DependsOn: []string{"invalid"}}, {Title: "Valid", DependsOn: []string{target.ID, strings.ToUpper(target.ID)}},
	} {
		_, err := tasks.Create(context.Background(), principal, project.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, input := range []UpdateTask{
		{Version: 0, Title: pointer("Changed")}, {Version: -1, Title: pointer("Changed")}, {Version: target.Version},
		{Version: target.Version, Title: pointer(" ")}, {Version: target.Version, Description: pointer("bad\x00")},
		{Version: target.Version, DependsOn: pointer([]string{"invalid"})},
		{Version: target.Version, DependsOn: pointer([]string{target.ID})},
		{Version: target.Version, DependsOn: pointer([]string{target.ID, strings.ToUpper(target.ID)})},
	} {
		_, err := tasks.Update(context.Background(), principal, project.ID, target.ID, input)
		requireFault(t, err, "invalid_input")
		assertTaskUnchanged(t, tasks, principal, target)
	}
	for _, operation := range []func() error{
		func() error {
			_, err := tasks.Create(context.Background(), principal, "invalid", CreateTask{Title: "Valid"})
			return err
		},
		func() error { _, err := tasks.Get(context.Background(), principal, "invalid", target.ID); return err },
		func() error { _, err := tasks.Get(context.Background(), principal, project.ID, "invalid"); return err },
		func() error {
			_, err := tasks.List(context.Background(), principal, "invalid", TaskListRequest{})
			return err
		},
		func() error {
			_, err := tasks.Update(context.Background(), principal, "invalid", target.ID, UpdateTask{})
			return err
		},
		func() error {
			_, err := tasks.Update(context.Background(), principal, project.ID, "invalid", UpdateTask{})
			return err
		},
	} {
		requireFault(t, operation(), "invalid_input")
	}
	sentinel := errors.New("entropy unavailable")
	uuid.SetRand(entropyFailure{sentinel})
	t.Cleanup(func() { uuid.SetRand(rand.Reader) })
	_, err := tasks.Create(context.Background(), principal, project.ID, CreateTask{Title: "Valid"})
	var fault *model.Fault
	if !errors.Is(err, sentinel) || errors.As(err, &fault) {
		t.Fatalf("task ID entropy error must retain cause: %v", err)
	}
}

func TestTaskScopeAndDependencyReferences(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	otherProject, err := NewProjects(database).Create(context.Background(), principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Other", RepoURL: "host:repo"})
	if err != nil {
		t.Fatal(err)
	}
	other := createTask(t, tasks, principal, otherProject.ID, "Other task")
	target := createTask(t, tasks, principal, project.ID, "Target")
	missingID := "00000000-0000-0000-0000-000000000000"
	for _, operation := range []func() error{
		func() error { _, err := tasks.Get(context.Background(), principal, project.ID, other.ID); return err },
		func() error { _, err := tasks.Get(context.Background(), principal, project.ID, missingID); return err },
		func() error { _, err := tasks.Get(context.Background(), principal, missingID, target.ID); return err },
		func() error {
			_, err := tasks.List(context.Background(), principal, missingID, TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
			return err
		},
		func() error {
			_, err := tasks.Create(context.Background(), principal, missingID, CreateTask{Title: "Missing project"})
			return err
		},
		func() error {
			_, err := tasks.Update(context.Background(), principal, missingID, target.ID, UpdateTask{Version: 1, Title: pointer("Changed")})
			return err
		},
		func() error {
			_, err := tasks.Update(context.Background(), principal, project.ID, other.ID, UpdateTask{Version: 1, Title: pointer("Changed")})
			return err
		},
	} {
		fault := requireFault(t, operation(), "not_found")
		if !errors.Is(fault, model.ErrNotFound) {
			t.Fatalf("missing cause: %#v", fault)
		}
	}
	refs := []string{other.ID, missingID}
	slices.Sort(refs)
	_, err = tasks.Create(context.Background(), principal, project.ID, CreateTask{Title: "Invalid refs", DependsOn: refs})
	fault := requireFault(t, err, "invalid_input")
	if !slices.Equal(fault.TaskIDs, refs) {
		t.Fatalf("scope-safe reference IDs: %v", fault.TaskIDs)
	}
	_, err = tasks.Update(context.Background(), principal, project.ID, target.ID, UpdateTask{Version: 1, DependsOn: &refs})
	requireFault(t, err, "invalid_input")
	assertTaskUnchanged(t, tasks, principal, target)
}

func TestTaskCyclesAndDependencyReplacement(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B", a.ID)
	c := createTask(t, tasks, principal, project.ID, "C", b.ID)
	for _, dependency := range []string{b.ID, c.ID} {
		_, err := tasks.Update(context.Background(), principal, project.ID, a.ID, UpdateTask{Version: a.Version, Title: pointer("Rejected"), DependsOn: pointer([]string{dependency})})
		fault := requireFault(t, err, "dependency_cycle")
		if !slices.Equal(fault.TaskIDs, []string{dependency}) {
			t.Fatalf("cycle details: %v", fault.TaskIDs)
		}
		assertTaskUnchanged(t, tasks, principal, a)
	}
	b = updateTask(t, tasks, principal, b, UpdateTask{DependsOn: pointer([]string{})})
	a = updateTask(t, tasks, principal, a, UpdateTask{DependsOn: pointer([]string{c.ID})})
	if len(b.DependsOn) != 0 || !slices.Equal(a.DependsOn, []string{c.ID}) {
		t.Fatalf("old edges were not replaced: A %#v, B %#v", a, b)
	}
	_, err := tasks.Update(context.Background(), principal, project.ID, b.ID, UpdateTask{Version: b.Version, DependsOn: pointer([]string{a.ID})})
	requireFault(t, err, "dependency_cycle")
	assertTaskUnchanged(t, tasks, principal, b)
}

func TestTaskSetStatusAllPairsAndVersionOrder(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	for _, from := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			t.Run(string(from)+"_to_"+string(to), func(t *testing.T) {
				task := createTask(t, tasks, principal, project.ID, "Status assignment")
				task = updateTask(t, tasks, principal, task, UpdateTask{AllowAgents: pointer(true), Description: pointer("Keep description"), Properties: propertyPatch(model.PullRequestProperty{URL: "https://example.com/pr/1", Title: "Keep evidence"})})
				if from != model.TaskTodo {
					task = startTask(t, tasks, principal, task)
				}
				if from == model.TaskDone {
					task = finishTask(t, tasks, principal, task)
				}
				_, err := tasks.SetStatus(context.Background(), principal, project.ID, task.ID, SetTaskStatus{Version: task.Version + 1, Status: to})
				requireFault(t, err, "version_conflict")
				assertTaskUnchanged(t, tasks, principal, task)
				after, err := tasks.SetStatus(context.Background(), principal, strings.ToUpper(project.ID), strings.ToUpper(task.ID), SetTaskStatus{Version: task.Version, Status: to})
				if err != nil {
					t.Fatal(err)
				}
				if from == to {
					if !reflect.DeepEqual(after, task) {
						t.Fatalf("same status mutated resource: %#v", after)
					}
					return
				}
				expected := task
				expected.Status, expected.Version, expected.UpdatedAt, expected.Ready = to, task.Version+1, after.UpdatedAt, to == model.TaskTodo
				if !after.UpdatedAt.After(task.UpdatedAt) {
					t.Fatal("status write did not advance time")
				}
				switch to {
				case model.TaskTodo:
					if after.StartedAt != nil || after.CompletedAt != nil {
						t.Fatal("todo retained execution timing")
					}
				case model.TaskInProgress:
					if after.StartedAt == nil || !after.StartedAt.Equal(after.UpdatedAt) || after.CompletedAt != nil {
						t.Fatal("start was not recorded atomically")
					}
				case model.TaskDone:
					if after.CompletedAt == nil || !after.CompletedAt.Equal(after.UpdatedAt) || !reflect.DeepEqual(after.StartedAt, task.StartedAt) {
						t.Fatal("completion changed the start or omitted its end")
					}
				}
				expected.StartedAt, expected.CompletedAt = after.StartedAt, after.CompletedAt
				if !reflect.DeepEqual(after, expected) {
					t.Fatalf("status changed unrelated fields: before %#v after %#v", task, after)
				}
				_, err = tasks.SetStatus(context.Background(), principal, project.ID, task.ID, SetTaskStatus{Version: task.Version, Status: to})
				requireFault(t, err, "version_conflict")
				same := setStatusTask(t, tasks, principal, after, to)
				if !reflect.DeepEqual(same, after) {
					t.Fatal("same-status request changed a completed mutation")
				}
			})
		}
	}
}

func TestTaskSetStatusValidationAndScope(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	otherProject, err := NewProjects(database).Create(context.Background(), principal, CreateProject{ExpectedUserID: principal.UserID, Name: "Other", RepoURL: "host:other"})
	if err != nil {
		t.Fatal(err)
	}
	other := createTask(t, tasks, principal, otherProject.ID, "Other")
	for _, input := range []SetTaskStatus{{Version: 0, Status: model.TaskTodo}, {Version: -1, Status: model.TaskDone}, {Version: 1, Status: ""}, {Version: 1, Status: "proposed"}, {Version: 1, Status: "TODO"}, {Version: 1, Status: " todo"}} {
		_, err := tasks.SetStatus(context.Background(), principal, project.ID, target.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, scope := range [][2]string{{"invalid", target.ID}, {project.ID, "invalid"}} {
		_, err := tasks.SetStatus(context.Background(), principal, scope[0], scope[1], SetTaskStatus{Version: 1, Status: model.TaskTodo})
		requireFault(t, err, "invalid_input")
	}
	missing := "00000000-0000-0000-0000-000000000000"
	for _, scope := range [][2]string{{missing, target.ID}, {project.ID, missing}, {project.ID, other.ID}} {
		_, err := tasks.SetStatus(context.Background(), principal, scope[0], scope[1], SetTaskStatus{Version: 1, Status: model.TaskTodo})
		fault := requireFault(t, err, "not_found")
		if !errors.Is(fault, model.ErrNotFound) {
			t.Fatalf("missing cause: %#v", fault)
		}
	}
	assertTaskUnchanged(t, tasks, principal, target)
	assertTaskUnchanged(t, tasks, principal, other)
}

func TestTaskSameStatusUsesCurrentDerivedStateAndExactLargeVersion(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	prerequisite := createTask(t, tasks, principal, project.ID, "Prerequisite")
	target := createTask(t, tasks, principal, project.ID, "Target", prerequisite.ID)
	const version int64 = 9007199254740993
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET version=$1 WHERE id=$2", version, target.ID); err != nil {
		t.Fatal(err)
	}
	target, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	finishTask(t, tasks, principal, prerequisite)
	after := setStatusTask(t, tasks, principal, target, model.TaskTodo)
	expected := target
	expected.Ready = true
	expected.BlockedBy = []string{}
	if !reflect.DeepEqual(after, expected) {
		t.Fatalf("same status lost new readiness or mutated materials: %#v", after)
	}
	changed := startTask(t, tasks, principal, after)
	if changed.Version != version+1 {
		t.Fatalf("large version rounded: %d", changed.Version)
	}
	_, err = tasks.SetStatus(context.Background(), principal, project.ID, target.ID, SetTaskStatus{Version: version, Status: model.TaskInProgress})
	requireFault(t, err, "version_conflict")
}

func TestTaskSetStatusDependencyProtectionAndNoCascade(t *testing.T) {
	for _, external := range []bool{false, true} {
		for _, successorStatus := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			for _, to := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress} {
				t.Run(fmt.Sprintf("external=%t_successor=%s_to=%s", external, successorStatus, to), func(t *testing.T) {
					tasks, _, project, _, principal := taskService(t)
					predecessor := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Predecessor"))
					successor := createTask(t, tasks, principal, project.ID, "Successor", predecessor.ID)
					if external {
						successor = updateTask(t, tasks, principal, successor, UpdateTask{ExternalDependsOn: pointer([]string{predecessor.ID})})
					}
					if successorStatus != model.TaskTodo {
						successor = setStatusTask(t, tasks, principal, successor, successorStatus)
					}
					after, err := tasks.SetStatus(context.Background(), principal, project.ID, predecessor.ID, SetTaskStatus{Version: predecessor.Version, Status: to})
					if successorStatus != model.TaskTodo {
						fault := requireFault(t, err, "dependency_unsatisfied")
						if !slices.Equal(fault.TaskIDs, []string{successor.ID}) {
							t.Fatalf("dependent IDs: %v", fault.TaskIDs)
						}
						assertTaskUnchanged(t, tasks, principal, predecessor)
						assertTaskUnchanged(t, tasks, principal, successor)
					} else {
						if err != nil || after.Status != to || after.Version != predecessor.Version+1 {
							t.Fatalf("todo successor blocked reopen: %#v %v", after, err)
						}
						current, err := tasks.Get(context.Background(), principal, project.ID, successor.ID)
						expected := successor
						expected.Ready = false
						expected.BlockedBy = []string{predecessor.ID}
						if err != nil || !reflect.DeepEqual(current, expected) {
							t.Fatalf("reopen cascaded mutation: %#v %v", current, err)
						}
					}
				})
			}
		}
	}
}

func TestTaskVersionAndSemanticNoop(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B")
	target := createTask(t, tasks, principal, project.ID, "Target", a.ID, b.ID)
	for _, input := range []UpdateTask{
		{Title: pointer(target.Title)}, {Description: pointer("")},
		{DependsOn: pointer([]string{strings.ToUpper(b.ID), strings.ToUpper(a.ID)})},
	} {
		got := updateTask(t, tasks, principal, target, input)
		if !reflect.DeepEqual(got, target) {
			t.Fatalf("semantic no-op changed task: %#v", got)
		}
	}
	changed := updateTask(t, tasks, principal, target, UpdateTask{Title: pointer("Changed"), Description: pointer("New"), DependsOn: pointer([]string{})})
	if changed.Version != target.Version+1 || changed.Title != "Changed" || changed.Description != "New" || len(changed.DependsOn) != 0 || !changed.UpdatedAt.After(target.UpdatedAt) {
		t.Fatalf("multi-field update: %#v", changed)
	}
	_, err := tasks.Update(context.Background(), principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer(changed.Title)})
	requireFault(t, err, "version_conflict")
	assertTaskUnchanged(t, tasks, principal, changed)
	cleared := updateTask(t, tasks, principal, changed, UpdateTask{Description: pointer("")})
	if cleared.Description != "" || cleared.Version != changed.Version+1 {
		t.Fatalf("clear description: %#v", cleared)
	}
}

func TestTaskCandidateDependencyRules(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	undone := createTask(t, tasks, principal, project.ID, "Undone")
	done := createTask(t, tasks, principal, project.ID, "Done")

	done = startTask(t, tasks, principal, done)
	done = finishTask(t, tasks, principal, done)
	blocked := createTask(t, tasks, principal, project.ID, "Blocked", undone.ID)
	blocked = updateTask(t, tasks, principal, blocked, UpdateTask{Title: pointer("Edited todo"), Description: pointer("Unfinished prerequisites allowed"), Properties: propertyPatch(model.PullRequestProperty{URL: "https://github.com/owner/repo/pull/1"})})
	if blocked.Status != model.TaskTodo || blocked.Ready {
		t.Fatalf("metadata changed status: %#v", blocked)
	}

	_, err := tasks.SetStatus(context.Background(), principal, project.ID, blocked.ID, SetTaskStatus{Version: blocked.Version, Status: model.TaskInProgress})
	fault := requireFault(t, err, "dependency_unsatisfied")
	if !slices.Equal(fault.TaskIDs, []string{undone.ID}) {
		t.Fatalf("unsatisfied prerequisite IDs: %v", fault.TaskIDs)
	}
	assertTaskUnchanged(t, tasks, principal, blocked)
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
		active := createTask(t, tasks, principal, project.ID, "Active", done.ID)

		active = startTask(t, tasks, principal, active)
		if status == model.TaskDone {
			active = finishTask(t, tasks, principal, active)
		}
		_, err = tasks.Update(context.Background(), principal, project.ID, active.ID, UpdateTask{Version: active.Version, DependsOn: pointer([]string{undone.ID})})
		requireFault(t, err, "dependency_unsatisfied")
		assertTaskUnchanged(t, tasks, principal, active)
		// Store fixtures bypass policy to verify full candidate checks on metadata-only updates.
		if err := database.WriteProject(context.Background(), project.ID, func(tx *store.ProjectTx) error {
			_, err := tx.UpdateTask(context.Background(), active.ID, store.TaskWrite{Title: active.Title, Status: status, DependsOn: []string{undone.ID}})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		corrupt, err := tasks.Get(context.Background(), principal, project.ID, active.ID)
		if err != nil {
			t.Fatal(err)
		}
		_, err = tasks.Update(context.Background(), principal, project.ID, active.ID, UpdateTask{Version: corrupt.Version, Title: pointer("Metadata")})
		requireFault(t, err, "dependency_unsatisfied")
		assertTaskUnchanged(t, tasks, principal, corrupt)
		if status == model.TaskInProgress {
			_, err = tasks.SetStatus(context.Background(), principal, project.ID, active.ID, SetTaskStatus{Version: corrupt.Version, Status: model.TaskDone})
			requireFault(t, err, "dependency_unsatisfied")
			assertTaskUnchanged(t, tasks, principal, corrupt)
		}
	}
}

func TestTaskListKeysetsFiltersAndCursorScopes(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	predecessor := createTask(t, tasks, principal, project.ID, "Predecessor")

	queued := createTask(t, tasks, principal, project.ID, "Queued")
	ready := createTask(t, tasks, principal, project.ID, "Ready")

	blocked := createTask(t, tasks, principal, project.ID, "Blocked", predecessor.ID)

	active := createTask(t, tasks, principal, project.ID, "Active")

	active = startTask(t, tasks, principal, active)
	done := createTask(t, tasks, principal, project.ID, "Done")

	done = startTask(t, tasks, principal, done)
	done = finishTask(t, tasks, principal, done)
	stamp := time.Date(2026, 2, 3, 4, 5, 6, 123456000, time.UTC)
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET created_at = $1 WHERE project_id = $2", stamp, project.ID); err != nil {
		t.Fatal(err)
	}
	want := []string{predecessor.ID, queued.ID, ready.ID, blocked.ID, active.ID, done.ID}
	slices.Sort(want)
	var got []string
	request := TaskListRequest{PageRequest: model.PageRequest{Limit: 2}}
	var firstCursor *string
	for {
		page, err := tasks.List(ctx, principal, strings.ToUpper(project.ID), request)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range page.Items {
			got = append(got, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		if firstCursor == nil {
			firstCursor = page.NextCursor
		}
		request.Cursor = page.NextCursor
	}
	if !slices.Equal(got, want) || firstCursor == nil {
		t.Fatalf("task keyset pages: %v, want %v", got, want)
	}
	for _, test := range []struct {
		status *model.TaskStatus
		ready  *bool
		ids    []string
	}{
		{nil, pointer(true), []string{predecessor.ID, queued.ID, ready.ID}},
		{nil, pointer(false), []string{blocked.ID, active.ID, done.ID}},
		{pointer(model.TaskTodo), nil, []string{predecessor.ID, queued.ID, ready.ID, blocked.ID}},
		{pointer(model.TaskTodo), pointer(false), []string{blocked.ID}},
		{pointer(model.TaskInProgress), nil, []string{active.ID}},
		{pointer(model.TaskDone), pointer(true), []string{}},
	} {
		page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, Status: test.status, Ready: test.ready})
		if err != nil || page.Items == nil || page.NextCursor != nil {
			t.Fatalf("filtered page: %#v, %v", page, err)
		}
		ids := make([]string, 0, len(page.Items))
		for _, task := range page.Items {
			ids = append(ids, task.ID)
		}
		slices.Sort(test.ids)
		if !slices.Equal(ids, test.ids) {
			t.Fatalf("filter results: %v, want %v", ids, test.ids)
		}
	}
	filtered, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 2}, Status: pointer(model.TaskTodo), Ready: pointer(true)})
	if err != nil || len(filtered.Items) != 2 || filtered.NextCursor == nil {
		t.Fatalf("filtered next page: %#v, %v", filtered, err)
	}
	final, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 1, Cursor: filtered.NextCursor}, Status: pointer(model.TaskTodo), Ready: pointer(true)})
	if err != nil || len(final.Items) != 1 || final.NextCursor != nil || final.Items[0].ID == filtered.Items[0].ID {
		t.Fatalf("filtered final page: %#v, %v", final, err)
	}
	for _, query := range []TaskListRequest{
		{PageRequest: model.PageRequest{Limit: 0}},
		{PageRequest: model.PageRequest{Limit: 10}, Status: pointer(model.TaskStatus(""))},
		{PageRequest: model.PageRequest{Limit: 10}, Status: pointer(model.TaskStatus("proposed"))},
		{PageRequest: model.PageRequest{Limit: 10, Cursor: pointer("")}},
		{PageRequest: model.PageRequest{Limit: 10, Cursor: firstCursor}, Status: pointer(model.TaskTodo)},
		{PageRequest: model.PageRequest{Limit: 10, Cursor: firstCursor}, Ready: pointer(false)},
		{PageRequest: model.PageRequest{Limit: 10, Cursor: filtered.NextCursor}, Status: pointer(model.TaskTodo), Ready: pointer(false)},
		{PageRequest: model.PageRequest{Limit: 10, Cursor: filtered.NextCursor}, Status: pointer(model.TaskTodo)},
	} {
		_, err := tasks.List(ctx, principal, project.ID, query)
		requireFault(t, err, "invalid_input")
	}
	_, err = tasks.List(ctx, principal, "00000000-0000-0000-0000-000000000000", TaskListRequest{PageRequest: model.PageRequest{Limit: 10, Cursor: firstCursor}})
	requireFault(t, err, "invalid_input")
	_, err = NewProjects(database).List(ctx, principal, model.PageRequest{Limit: 10, Cursor: firstCursor})
	requireFault(t, err, "invalid_input")
	projectCursor, err := query.EncodeProjectCursor(project, principal.UserID, store.ProjectScope{Kind: store.ProjectScopeAll})
	if err != nil {
		t.Fatal(err)
	}
	_, err = tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 10, Cursor: &projectCursor}})
	requireFault(t, err, "invalid_input")
}

func TestTaskCursorEncodingFailure(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	for index := 0; index < 2; index++ {
		createTask(t, tasks, principal, project.ID, fmt.Sprint(index))
	}
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET created_at = '10000-01-01'::timestamptz"); err != nil {
		t.Fatal(err)
	}
	_, err := tasks.List(context.Background(), principal, project.ID, TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
	var fault *model.Fault
	if err == nil || errors.As(err, &fault) || !strings.Contains(err.Error(), "encode task cursor") {
		t.Fatalf("unrepresentable cursor must fail: %v", err)
	}
}

func TestTaskStatusAllPrerequisitesAndUnknownLegacyStart(t *testing.T) {
	for _, external := range []bool{false, true} {
		t.Run(fmt.Sprint(external), func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			a := createTask(t, tasks, principal, project.ID, "Unfinished A")
			b := createTask(t, tasks, principal, project.ID, "Unfinished B")
			target := createTask(t, tasks, principal, project.ID, "Blocked", a.ID, b.ID)
			if external {
				target = updateTask(t, tasks, principal, target, UpdateTask{ExternalDependsOn: &target.DependsOn})
			}
			want := []string{a.ID, b.ID}
			slices.Sort(want)
			for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
				_, err := tasks.SetStatus(context.Background(), principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: status})
				fault := requireFault(t, err, "dependency_unsatisfied")
				if !slices.Equal(fault.TaskIDs, want) {
					t.Fatalf("unsatisfied IDs not complete/sorted: %v", fault.TaskIDs)
				}
				assertTaskUnchanged(t, tasks, principal, target)
			}
			finishTask(t, tasks, principal, a)
			finishTask(t, tasks, principal, b)
			target, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
			if err != nil {
				t.Fatal(err)
			}
			target = startTask(t, tasks, principal, target)
			if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET started_at=NULL WHERE id=$1", target.ID); err != nil {
				t.Fatal(err)
			}
			target, err = tasks.Get(context.Background(), principal, project.ID, target.ID)
			if err != nil {
				t.Fatal(err)
			}
			completed := finishTask(t, tasks, principal, target)
			if completed.StartedAt != nil || completed.CompletedAt == nil {
				t.Fatal("completion inferred an unknown historical start")
			}
		})
	}
}

func TestTaskStatusReopenReturnsAllSortedActiveDependents(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	predecessor := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Predecessor"))
	a := startTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Active", predecessor.ID))
	b := createTask(t, tasks, principal, project.ID, "Completed external", predecessor.ID)
	b = updateTask(t, tasks, principal, b, UpdateTask{ExternalDependsOn: &b.DependsOn})
	b = finishTask(t, tasks, principal, b)
	idle := createTask(t, tasks, principal, project.ID, "Idle", predecessor.ID)
	want := []string{a.ID, b.ID}
	slices.Sort(want)
	_, err := tasks.SetStatus(context.Background(), principal, project.ID, predecessor.ID, SetTaskStatus{Version: predecessor.Version, Status: model.TaskTodo})
	fault := requireFault(t, err, "dependency_unsatisfied")
	if !slices.Equal(fault.TaskIDs, want) {
		t.Fatalf("dependent IDs not complete/sorted: %v", fault.TaskIDs)
	}
	for _, task := range []model.Task{predecessor, a, b, idle} {
		assertTaskUnchanged(t, tasks, principal, task)
	}
}
