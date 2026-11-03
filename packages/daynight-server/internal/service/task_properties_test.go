package service

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskPropertiesCandidateFailureAndPartialWriteRollback(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	ctx := context.Background()
	prerequisite := createTask(t, tasks, principal, project.ID, "Prerequisite")
	old := createTask(t, tasks, principal, project.ID, "Old")

	old = startTask(t, tasks, principal, old)
	old = finishTask(t, tasks, principal, old)
	target, err := tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Original", DependsOn: []string{old.ID}, Properties: propertyPatch([]core.PullRequestProperty{{URL: "old\x00", Title: "Old"}}...)})
	if err != nil {
		t.Fatal(err)
	}

	target = startTask(t, tasks, principal, target)
	properties := propertyPatch(core.PullRequestProperty{URL: "changed\x00", Title: "Changed"})
	_, err = tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}), Properties: properties})
	requireFault(t, err, "dependency_unsatisfied")
	assertTaskUnchanged(t, tasks, principal, target)

	prerequisite = startTask(t, tasks, principal, prerequisite)
	prerequisite = finishTask(t, tasks, principal, prerequisite)
	for _, fragment := range []string{"UPDATE tasks SET", "INSERT INTO task_dependencies"} {
		t.Run("cancel after "+fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := tracedTasks(t, databaseURL, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel})
			_, err := traced.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}), Properties: properties})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("partial-write cancellation lost cause: %v", err)
			}
			assertTaskUnchanged(t, tasks, principal, target)
		})
	}
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_property_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'rejected dependency'; END $$;
		CREATE TRIGGER reject_property_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_property_edge()`); err != nil {
		t.Fatal(err)
	}
	_, err = tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Title: pointer("Changed"), Description: pointer("Changed"), DependsOn: pointer([]string{prerequisite.ID}), Properties: properties})
	assertOperational(t, err)
	assertTaskUnchanged(t, tasks, principal, target)
	_, err = tasks.Create(ctx, principal, project.ID, CreateTask{Title: "Rejected", DependsOn: []string{prerequisite.ID}, Properties: properties})
	assertOperational(t, err)
	page, err := tasks.List(ctx, principal, project.ID, TaskListRequest{PageRequest: PageRequest{Limit: 100}})
	if err != nil || len(page.Items) != 3 {
		t.Fatalf("partial create persisted: %+v, %v", page, err)
	}
}

func TestTaskPropertiesConcurrentVersionAndSnapshot(t *testing.T) {
	tasks, database, project, databaseURL, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Original")
	first, second := propertyPatch(core.PullRequestProperty{URL: "first", Title: "First"}), propertyPatch(core.PullRequestProperty{URL: "second", Title: "Second"})
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Properties: first})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, principal, project.ID, target.ID, UpdateTask{Version: target.Version, Properties: second})
		})
	assertOneTaskWinner(t, results, "version_conflict")
	before, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || before.Version != target.Version+1 || !(slices.Equal(testPRs(t, before.Properties), testPRs(t, first)) || slices.Equal(testPRs(t, before.Properties), testPRs(t, second))) {
		t.Fatalf("concurrent property result: %+v, %v", before, err)
	}
	traced := tracedTasks(t, databaseURL, taskQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "FROM project_members m") },
		end: func() {
			if err := database.WriteProject(context.Background(), project.ID, func(tx *store.ProjectTx) error {
				_, err := tx.UpdateTask(context.Background(), before.ID, store.TaskWrite{Title: "New snapshot", Status: before.Status, Properties: propertyPatch([]core.PullRequestProperty{{URL: "new", Title: "New"}}...)})
				return err
			}); err != nil {
				t.Fatal(err)
			}
		},
	})
	read, err := traced.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || !reflect.DeepEqual(read, before) {
		t.Fatalf("snapshot mixed task fields and properties: %+v, %v", read, err)
	}
	after, err := tasks.Get(context.Background(), principal, project.ID, target.ID)
	if err != nil || after.Title != "New snapshot" || after.Version != before.Version+1 || !slices.Equal(testPRs(t, after.Properties), []core.PullRequestProperty{{URL: "new", Title: "New"}}) {
		t.Fatalf("fresh properties snapshot: %+v, %v", after, err)
	}
}
