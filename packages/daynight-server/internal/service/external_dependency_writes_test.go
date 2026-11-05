package service

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func createClassifiedTask(t *testing.T, tasks *Tasks, principal model.Principal, projectID, title string, dependencies, external []string) model.Task {
	t.Helper()
	task, err := tasks.Create(context.Background(), principal, projectID, CreateTask{Title: title, DependsOn: dependencies, ExternalDependsOn: external})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestExternalDependencyWriteCandidateMatrix(t *testing.T) {
	for _, name := range []string{"neither", "dependencies only", "external only", "both", "clear dependencies", "clear external", "clear both", "canonical no-op"} {
		t.Run(name, func(t *testing.T) {
			tasks, _, project, _, principal := taskService(t)
			a := createTask(t, tasks, principal, project.ID, "A")
			b := createTask(t, tasks, principal, project.ID, "B")
			c := createTask(t, tasks, principal, project.ID, "C")
			target := createClassifiedTask(t, tasks, principal, project.ID, "Target", []string{b.ID, strings.ToUpper(a.ID)}, []string{strings.ToUpper(b.ID)})
			wantDependencies, wantExternal := []string{a.ID, b.ID}, []string{b.ID}
			input := UpdateTask{}
			switch name {
			case "neither":
				input.Title = pointer("Renamed")
			case "dependencies only":
				input.DependsOn = pointer([]string{c.ID, b.ID})
				wantDependencies = []string{b.ID, c.ID}
			case "external only":
				input.ExternalDependsOn = pointer([]string{a.ID})
				wantExternal = []string{a.ID}
			case "both":
				input.DependsOn, input.ExternalDependsOn = pointer([]string{c.ID}), pointer([]string{c.ID})
				wantDependencies, wantExternal = []string{c.ID}, []string{c.ID}
			case "clear dependencies":
				input.DependsOn = pointer([]string{})
				wantDependencies, wantExternal = []string{}, []string{}
			case "clear external":
				input.ExternalDependsOn = pointer([]string{})
				wantExternal = []string{}
			case "clear both":
				input.DependsOn, input.ExternalDependsOn = pointer([]string{}), pointer([]string{})
				wantDependencies, wantExternal = []string{}, []string{}
			case "canonical no-op":
				input.DependsOn, input.ExternalDependsOn = pointer([]string{strings.ToUpper(b.ID), a.ID}), pointer([]string{strings.ToUpper(b.ID)})
			}
			slices.Sort(wantDependencies)
			slices.Sort(wantExternal)
			updated := updateTask(t, tasks, principal, target, input)
			if !slices.Equal(updated.DependsOn, wantDependencies) || !slices.Equal(updated.ExternalDependsOn, wantExternal) {
				t.Fatalf("candidate lost replacement semantics: %#v", updated)
			}
			if name == "canonical no-op" {
				if !reflect.DeepEqual(updated, target) {
					t.Fatal("canonical no-op changed persisted metadata")
				}
			} else if updated.Version != target.Version+1 || !updated.UpdatedAt.After(target.UpdatedAt) {
				t.Fatal("changed candidate did not advance metadata exactly once")
			}
		})
	}
}

func TestExternalDependencyFlagsOnlyKeepExecutionIntervalsAndVersionOrder(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := context.Background()
	a := finishTask(t, tasks, principal, startTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "A")))
	b := finishTask(t, tasks, principal, startTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "B")))
	target := createClassifiedTask(t, tasks, principal, project.ID, "Target", []string{a.ID, b.ID}, nil)
	target = updateTask(t, tasks, principal, target, UpdateTask{AllowAgents: pointer(true)})
	target = startTask(t, tasks, principal, target)
	for _, external := range [][]string{{a.ID}, {b.ID}} {
		before := target
		target = updateTask(t, tasks, principal, target, UpdateTask{ExternalDependsOn: &external})
		preserved := target
		preserved.ExternalDependsOn, preserved.Version, preserved.UpdatedAt = before.ExternalDependsOn, before.Version, before.UpdatedAt
		if target.Version != before.Version+1 || !target.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
			t.Fatalf("flags-only mutation changed execution or unrelated fields: before=%#v after=%#v", before, target)
		}
		_, err := tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: before.Version, ExternalDependsOn: &external})
		requireFault(t, err, "version_conflict")
		noop := updateTask(t, tasks, principal, target, UpdateTask{ExternalDependsOn: &external})
		if !reflect.DeepEqual(noop, target) {
			t.Fatal("same classification advanced metadata")
		}
		if target.Status == model.TaskInProgress {
			target = finishTask(t, tasks, principal, target)
		}
	}
	_, err := tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version - 1, ExternalDependsOn: pointer([]string{uuid.NewString()})})
	requireFault(t, err, "version_conflict")
	assertTaskUnchanged(t, tasks, principal, target)
}

func TestExternalDependencyWritesRejectInvalidCandidatesAndAllEdgeCycles(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B")
	foreignProject, err := projectservice.NewProjects(database).Create(ctx, principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Foreign", RepoURL: "https://example.com/foreign"})
	if err != nil {
		t.Fatal(err)
	}
	foreign := createTask(t, tasks, principal, foreignProject.ID, "Foreign prerequisite")
	target := createClassifiedTask(t, tasks, principal, project.ID, "Target", []string{a.ID}, []string{a.ID})
	for _, input := range []CreateTask{
		{Title: "Invalid", ExternalDependsOn: []string{a.ID}},
		{Title: "Invalid", DependsOn: []string{a.ID}, ExternalDependsOn: []string{"bad"}},
		{Title: "Invalid", DependsOn: []string{a.ID}, ExternalDependsOn: []string{a.ID, strings.ToUpper(a.ID)}},
		{Title: "Invalid", DependsOn: []string{a.ID}, ExternalDependsOn: []string{b.ID}},
		{Title: "Invalid", DependsOn: []string{foreign.ID}, ExternalDependsOn: []string{foreign.ID}},
		{Title: "Invalid", DependsOn: []string{uuid.NewString()}},
	} {
		_, err := tasks.Create(ctx, principal, project.ID, input)
		requireFault(t, err, "invalid_input")
	}
	for _, input := range []UpdateTask{
		{ExternalDependsOn: pointer([]string{"bad"})},
		{ExternalDependsOn: pointer([]string{a.ID, strings.ToUpper(a.ID)})},
		{ExternalDependsOn: pointer([]string{target.ID})},
		{ExternalDependsOn: pointer([]string{b.ID})},
		{DependsOn: pointer([]string{}), ExternalDependsOn: pointer([]string{a.ID})},
		{DependsOn: pointer([]string{foreign.ID}), ExternalDependsOn: pointer([]string{foreign.ID})},
		{DependsOn: pointer([]string{target.ID}), ExternalDependsOn: pointer([]string{target.ID})},
	} {
		input.Version = target.Version
		_, err := tasks.Update(ctx, principal, project.ID, target.ID, input)
		requireFault(t, err, "invalid_input")
		assertTaskUnchanged(t, tasks, principal, target)
	}
	for _, external := range [][]string{nil, {target.ID}} {
		_, err := tasks.Update(ctx, principal, project.ID, a.ID, UpdateTask{Version: a.Version, DependsOn: pointer([]string{target.ID}), ExternalDependsOn: &external})
		requireFault(t, err, "dependency_cycle")
		assertTaskUnchanged(t, tasks, principal, a)
	}

	_, err = tasks.SetStatus(ctx, principal, project.ID, target.ID, SetTaskStatus{Version: target.Version, Status: model.TaskInProgress})
	requireFault(t, err, "dependency_unsatisfied")
	assertTaskUnchanged(t, tasks, principal, target)
}

func TestExternalDependencyWriteRacesAndPartialFailures(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B")
	target := createClassifiedTask(t, tasks, principal, project.ID, "Target", []string{a.ID, b.ID}, nil)
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, ExternalDependsOn: pointer([]string{a.ID})})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, ExternalDependsOn: pointer([]string{b.ID})})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	target, err := tasks.Get(ctx, principal, project.ID, target.ID)
	if err != nil || target.Version != 2 || len(target.ExternalDependsOn) != 1 {
		t.Fatalf("concurrent classification writes lost a winner: %#v, %v", target, err)
	}
	for _, fragment := range []string{"UPDATE tasks SET", "INSERT INTO task_dependencies"} {
		t.Run("cancel after "+fragment, func(t *testing.T) {
			queryContext, cancel := context.WithCancel(ctx)
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel})
			_, err := traced.Update(queryContext, principal, project.ID, target.ID, UpdateTask{Version: target.Version, ExternalDependsOn: pointer([]string{a.ID, b.ID})})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("classification cancellation lost its cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, principal, target)
		})
	}
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_external_edge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private external edge diagnostic'; END $$;
		CREATE TRIGGER reject_external_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_external_edge()`); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, ExternalDependsOn: pointer([]string{a.ID, b.ID})})
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P0001" || strings.Contains(err.Error(), "private external") {
		t.Fatalf("classification failure lost or exposed its native cause: %v", err)
	}
	assertTaskUnchanged(t, tasks, principal, target)
}

func TestExternalDependencyWriteChecksMembershipAfterProjectLock(t *testing.T) {
	f := newMembershipFixture(t)
	admin, member := f.user(t), f.user(t)
	project := f.project(t, admin, "Classification authorization")
	f.join(t, admin, member, project.ID)
	tasks := NewTasks(f.database)
	a := createTask(t, tasks, admin, project.ID, "A")
	target := createClassifiedTask(t, tasks, admin, project.ID, "Target", []string{a.ID}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result := make(chan taskResult, 1)
	if _, err := f.database.WriteProject(ctx, project.ID, func(tx store.ProjectWriteScope) error {
		go func() {
			task, err := tasks.Update(ctx, member, project.ID, target.ID, UpdateTask{Version: target.Version, ExternalDependsOn: pointer([]string{a.ID})})
			result <- taskResult{task: task, err: err}
		}()
		waitForTaskWriters(t, ctx, f.database, 1)
		return tx.ProjectDAO().RemoveMember(ctx, member.UserID)
	}); err != nil {
		t.Fatal(err)
	}
	refused := receiveTaskResult(t, ctx, result)
	requireFault(t, refused.err, "not_found")
	assertTaskUnchanged(t, tasks, admin, target)
}
