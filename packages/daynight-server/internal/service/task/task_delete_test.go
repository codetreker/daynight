package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func deletedTaskStorage(t *testing.T, database *postgres.Store, task model.Task) (string, *time.Time, time.Time, int64) {
	t.Helper()
	var data string
	var deleted *time.Time
	var updated time.Time
	var version int64
	if err := database.Pool.QueryRow(context.Background(), `SELECT
		(to_jsonb(t)-'deleted_at'-'updated_at'-'version')::text, deleted_at, updated_at, version
		FROM tasks t WHERE project_id=$1 AND id=$2`, task.ProjectID, task.ID).Scan(&data, &deleted, &updated, &version); err != nil {
		t.Fatal(err)
	}
	return data, deleted, updated, version
}

func TestTaskDeletionProtectsVersionDependenciesAndWorker(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	pre := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Pre"))
	var dependents []model.Task
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		dependent := createTask(t, tasks, principal, project.ID, "Dependent", pre.ID)
		dependent = setStatusTask(t, tasks, principal, dependent, status)
		dependents = append(dependents, dependent)
	}
	before, _, _, _ := deletedTaskStorage(t, database, pre)
	var epoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	requireFault(t, tasks.Delete(ctx, principal, project.ID, pre.ID, taskcore.DeleteTask{Version: pre.Version + 1}), "version_conflict")
	fault := requireFault(t, tasks.Delete(ctx, principal, project.ID, pre.ID, taskcore.DeleteTask{Version: pre.Version}), "dependency_unsatisfied")
	want := []string{dependents[0].ID, dependents[1].ID, dependents[2].ID}
	slices.Sort(want)
	if !slices.Equal(fault.TaskIDs, want) {
		t.Fatalf("missing dependent IDs: %#v", fault)
	}
	assertTaskUnchanged(t, tasks, principal, pre)
	after, marker, _, _ := deletedTaskStorage(t, database, pre)
	var afterEpoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&afterEpoch); err != nil || marker != nil || before != after || epoch != afterEpoch {
		t.Fatalf("refusal mutated marker/data/epoch: %v %v", marker, err)
	}
	active := claimWorkerTask(t, tasks, principal, claimableTask(t, tasks, principal, project.ID), workerDescriptor())
	requireFault(t, tasks.Delete(ctx, principal, project.ID, active.ID, taskcore.DeleteTask{Version: active.Version}), "invalid_transition")
	released, err := tasks.ReleaseWorker(ctx, principal, project.ID, active.ID, taskcore.ReleaseWorker{Version: active.Version, ClaimID: testWorker(t, active.Properties).ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := tasks.Delete(ctx, principal, project.ID, released.ID, taskcore.DeleteTask{Version: released.Version}); err != nil {
		t.Fatal(err)
	}
	for _, dependent := range dependents {
		if err := tasks.Delete(ctx, principal, project.ID, dependent.ID, taskcore.DeleteTask{Version: dependent.Version}); err != nil {
			t.Fatalf("status %s cannot be deleted: %v", dependent.Status, err)
		}
	}
	if err := tasks.Delete(ctx, principal, project.ID, pre.ID, taskcore.DeleteTask{Version: pre.Version}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskDeletionValidationAndAccessDoNotExposeHistory(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	task := createTask(t, tasks, principal, project.ID, "Private")
	stranger := servicePrincipal(t, database)
	requireFault(t, tasks.Delete(ctx, model.Principal{}, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version}), "unauthenticated")
	requireFault(t, tasks.Delete(ctx, principal, "invalid", task.ID, taskcore.DeleteTask{Version: task.Version}), "invalid_input")
	requireFault(t, tasks.Delete(ctx, principal, project.ID, "invalid", taskcore.DeleteTask{Version: task.Version}), "invalid_input")
	requireFault(t, tasks.Delete(ctx, principal, project.ID, task.ID, taskcore.DeleteTask{Version: 0}), "invalid_input")
	requireFault(t, tasks.Delete(ctx, stranger, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version}), "not_found")
	requireFault(t, tasks.Delete(ctx, principal, project.ID, "00000000-0000-4000-8000-000000000099", taskcore.DeleteTask{Version: 1}), "not_found")
	assertTaskUnchanged(t, tasks, principal, task)
	if err := tasks.Delete(ctx, principal, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version}); err != nil {
		t.Fatal(err)
	}
	_, err := tasks.Get(ctx, stranger, project.ID, task.ID)
	requireFault(t, err, "not_found")
	requireFault(t, tasks.Delete(ctx, stranger, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version}), "not_found")
}

func TestTaskDeletionSerializesWithDependencyCreation(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	pre := createTask(t, tasks, principal, project.ID, "Prerequisite")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (model.Task, error) {
			return model.Task{}, tasks.Delete(ctx, principal, project.ID, pre.ID, taskcore.DeleteTask{Version: pre.Version})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "New dependent", DependsOn: []string{pre.ID}})
		})
	success := 0
	for _, result := range results {
		if result.err == nil {
			success++
			continue
		}
		var fault *model.Fault
		if !errors.As(result.err, &fault) || fault.Code != "invalid_input" && fault.Code != "dependency_unsatisfied" {
			t.Fatalf("unexpected concurrent refusal: %v", result.err)
		}
	}
	if success != 1 {
		t.Fatalf("both deletion and a live reference committed: %#v", results)
	}
	page, err := tasks.List(context.Background(), principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}})
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range page.Items {
		for _, dependency := range task.DependsOn {
			if !slices.ContainsFunc(page.Items, func(candidate model.Task) bool { return candidate.ID == dependency }) {
				t.Fatal("concurrent write left a dangling active dependency")
			}
		}
	}
}

func TestTaskDeletionRollsBackWhenEpochInvalidationFails(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "Unchanged")
	ctx := context.Background()
	if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_epoch_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'epoch rotation failed'; END $$;
		CREATE TRIGGER reject_epoch_rotation BEFORE UPDATE OF task_cache_epoch ON projects
		FOR EACH ROW EXECUTE FUNCTION reject_epoch_rotation()`); err != nil {
		t.Fatal(err)
	}
	err := tasks.Delete(ctx, principal, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version})
	if err == nil {
		t.Fatal("epoch failure was hidden")
	}
	assertTaskUnchanged(t, tasks, principal, task)
	_, marker, _, version := deletedTaskStorage(t, database, task)
	if marker != nil || version != task.Version {
		t.Fatal("failed cache invalidation committed a deletion")
	}
}

func TestTaskDeletionPreservesCompletedWorkerHistory(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	task := claimWorkerTask(t, tasks, principal, claimableTask(t, tasks, principal, project.ID), workerDescriptor())
	completed, err := tasks.SetStatus(context.Background(), principal, project.ID, task.ID, taskcore.SetTaskStatus{Version: task.Version, Status: model.TaskDone, ClaimID: &testWorker(t, task.Properties).ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	before, _, _, _ := deletedTaskStorage(t, database, completed)
	if err := tasks.Delete(context.Background(), principal, project.ID, completed.ID, taskcore.DeleteTask{Version: completed.Version}); err != nil {
		t.Fatal(err)
	}
	after, _, _, _ := deletedTaskStorage(t, database, completed)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("completed worker history was lost")
	}
}
