package service

import (
	"context"
	"errors"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func deletedTaskStorage(t *testing.T, database *store.Store, task core.Task) (string, *time.Time, time.Time, int64) {
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

func TestTaskDeletionPreservesDataAndReplacesSyncBaseline(t *testing.T) {
	attachments, tasks, database, files, task, principal := attachmentService(t)
	ctx := context.Background()
	pre := finishTask(t, tasks, principal, createTask(t, tasks, principal, task.ProjectID, "Prerequisite"))
	task = updateTask(t, tasks, principal, task, UpdateTask{Description: pointer("Preserved body"), DependsOn: pointer([]string{pre.ID}), ExternalDependsOn: pointer([]string{pre.ID}), Properties: propertyPatch(core.PullRequestProperty{URL: "PR", Title: "Retained evidence"})})
	attachment := putAttachment(t, attachments, principal, task, "evidence.txt", "retained bytes")
	before, marker, _, _ := deletedTaskStorage(t, database, task)
	if marker != nil {
		t.Fatal("new task starts deleted")
	}
	sync := NewTaskSync(database, time.Second)
	baseline, err := sync.Get(ctx, principal, task.ProjectID, TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tasks.Delete(ctx, principal, strings.ToUpper(task.ProjectID), strings.ToUpper(task.ID), DeleteTask{Version: task.Version}); err != nil {
		t.Fatal(err)
	}
	after, marker, updated, version := deletedTaskStorage(t, database, task)
	if before != after || marker == nil || !marker.Equal(updated) || !updated.After(task.UpdatedAt) || version != task.Version+1 {
		t.Fatalf("soft deletion changed data or failed to record one atomic version: %s %s %v %v %d", before, after, marker, updated, version)
	}
	var edgeCount, attachmentCount int
	if err := database.Pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM task_dependencies WHERE task_id=$1),
		(SELECT count(*) FROM task_attachments WHERE task_id=$1)`, task.ID).Scan(&edgeCount, &attachmentCount); err != nil || edgeCount != 1 || attachmentCount != 1 {
		t.Fatalf("physical evidence removed: %d %d %v", edgeCount, attachmentCount, err)
	}
	object, err := files.Open(ctx, attachmentBucket, attachmentTestStoragePath(task, attachment.Path))
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "retained bytes" {
		t.Fatalf("attachment bytes changed: %q %v %v", content, readErr, closeErr)
	}
	for _, ready := range []*bool{nil, pointer(true), pointer(false)} {
		page, err := tasks.List(ctx, principal, task.ProjectID, TaskListRequest{PageRequest: PageRequest{Limit: 100}, Ready: ready})
		if err != nil || slices.ContainsFunc(page.Items, func(item core.Task) bool { return item.ID == task.ID }) {
			t.Fatalf("deleted task is listed: %#v %v", page, err)
		}
	}
	graph, err := tasks.Graph(ctx, principal, task.ProjectID)
	if err != nil || len(graph.Tasks) != 1 || graph.Tasks[0].ID != pre.ID || graph.Summary.Total != 1 {
		t.Fatalf("deleted task counted in graph: %#v %v", graph, err)
	}
	current, err := sync.Get(ctx, principal, task.ProjectID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &baseline.ObservedAt})
	if err != nil || current.Mode != "snapshot" || current.Epoch == baseline.Epoch || len(current.Tasks) != 1 || current.Tasks[0].ID != pre.ID {
		t.Fatalf("old caches were not replaced: %#v %v", current, err)
	}
	_, err = tasks.Get(ctx, principal, task.ProjectID, task.ID)
	fault := requireFault(t, err, "task_deleted")
	if !errors.Is(fault, core.ErrTaskDeleted) {
		t.Fatal("deleted task cause lost")
	}
	_, err = tasks.Update(ctx, principal, task.ProjectID, task.ID, UpdateTask{Version: version, Title: pointer("Changed")})
	requireFault(t, err, "task_deleted")
	_, err = tasks.SetStatus(ctx, principal, task.ProjectID, task.ID, SetTaskStatus{Version: version, Status: core.TaskDone})
	requireFault(t, err, "task_deleted")
	requireFault(t, tasks.Delete(ctx, principal, task.ProjectID, task.ID, DeleteTask{Version: version}), "task_deleted")
	_, err = tasks.ClaimWorker(ctx, principal, task.ProjectID, task.ID, ClaimWorker{Version: version, WorkerDescriptor: workerDescriptor()})
	requireFault(t, err, "task_deleted")
	_, err = tasks.Create(ctx, principal, task.ProjectID, CreateTask{Title: "Invalid reference", DependsOn: []string{task.ID}})
	requireFault(t, err, "invalid_input")
	_, err = attachments.List(ctx, principal, task.ProjectID, task.ID, PageRequest{Limit: 100})
	requireFault(t, err, "task_deleted")
	_, _, err = attachments.Open(ctx, principal, task.ProjectID, task.ID, attachment.Path)
	requireFault(t, err, "task_deleted")
	_, _, err = attachments.Put(ctx, principal, task.ProjectID, task.ID, attachment.Path, "text/plain", strings.NewReader("overwrite"))
	requireFault(t, err, "task_deleted")
	requireFault(t, attachments.Delete(ctx, principal, task.ProjectID, task.ID, attachment.Path), "task_deleted")
	// Retained outgoing history must not prevent deleting the former prerequisite.
	if err := tasks.Delete(ctx, principal, task.ProjectID, pre.ID, DeleteTask{Version: pre.Version}); err != nil {
		t.Fatal(err)
	}
	graph, err = tasks.Graph(ctx, principal, task.ProjectID)
	if err != nil || len(graph.Tasks) != 0 || graph.Summary != (core.TaskGraphSummary{}) {
		t.Fatalf("historical tasks or edges leaked into active graph: %#v %v", graph, err)
	}
}

func TestTaskDeletionProtectsVersionDependenciesAndWorker(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	pre := finishTask(t, tasks, principal, createTask(t, tasks, principal, project.ID, "Pre"))
	var dependents []core.Task
	for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
		dependent := createTask(t, tasks, principal, project.ID, "Dependent", pre.ID)
		dependent = setStatusTask(t, tasks, principal, dependent, status)
		dependents = append(dependents, dependent)
	}
	before, _, _, _ := deletedTaskStorage(t, database, pre)
	var epoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	requireFault(t, tasks.Delete(ctx, principal, project.ID, pre.ID, DeleteTask{Version: pre.Version + 1}), "version_conflict")
	fault := requireFault(t, tasks.Delete(ctx, principal, project.ID, pre.ID, DeleteTask{Version: pre.Version}), "dependency_unsatisfied")
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
	requireFault(t, tasks.Delete(ctx, principal, project.ID, active.ID, DeleteTask{Version: active.Version}), "invalid_transition")
	released, err := tasks.ReleaseWorker(ctx, principal, project.ID, active.ID, ReleaseWorker{Version: active.Version, ClaimID: active.Properties.Worker.ClaimID, StoppedConfirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := tasks.Delete(ctx, principal, project.ID, released.ID, DeleteTask{Version: released.Version}); err != nil {
		t.Fatal(err)
	}
	for _, dependent := range dependents {
		if err := tasks.Delete(ctx, principal, project.ID, dependent.ID, DeleteTask{Version: dependent.Version}); err != nil {
			t.Fatalf("status %s cannot be deleted: %v", dependent.Status, err)
		}
	}
	if err := tasks.Delete(ctx, principal, project.ID, pre.ID, DeleteTask{Version: pre.Version}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskDeletionValidationAndAccessDoNotExposeHistory(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	task := createTask(t, tasks, principal, project.ID, "Private")
	stranger := servicePrincipal(t, database)
	requireFault(t, tasks.Delete(ctx, core.Principal{}, project.ID, task.ID, DeleteTask{Version: task.Version}), "unauthenticated")
	requireFault(t, tasks.Delete(ctx, principal, "invalid", task.ID, DeleteTask{Version: task.Version}), "invalid_input")
	requireFault(t, tasks.Delete(ctx, principal, project.ID, "invalid", DeleteTask{Version: task.Version}), "invalid_input")
	requireFault(t, tasks.Delete(ctx, principal, project.ID, task.ID, DeleteTask{Version: 0}), "invalid_input")
	requireFault(t, tasks.Delete(ctx, stranger, project.ID, task.ID, DeleteTask{Version: task.Version}), "not_found")
	requireFault(t, tasks.Delete(ctx, principal, project.ID, "00000000-0000-4000-8000-000000000099", DeleteTask{Version: 1}), "not_found")
	assertTaskUnchanged(t, tasks, principal, task)
	if err := tasks.Delete(ctx, principal, project.ID, task.ID, DeleteTask{Version: task.Version}); err != nil {
		t.Fatal(err)
	}
	_, err := tasks.Get(ctx, stranger, project.ID, task.ID)
	requireFault(t, err, "not_found")
	requireFault(t, tasks.Delete(ctx, stranger, project.ID, task.ID, DeleteTask{Version: task.Version}), "not_found")
}

func TestTaskDeletionSerializesWithDependencyCreation(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	pre := createTask(t, tasks, principal, project.ID, "Prerequisite")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return core.Task{}, tasks.Delete(ctx, principal, project.ID, pre.ID, DeleteTask{Version: pre.Version})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.Create(ctx, principal, project.ID, CreateTask{Title: "New dependent", DependsOn: []string{pre.ID}})
		})
	success := 0
	for _, result := range results {
		if result.err == nil {
			success++
			continue
		}
		var fault *Fault
		if !errors.As(result.err, &fault) || fault.Code != "invalid_input" && fault.Code != "dependency_unsatisfied" {
			t.Fatalf("unexpected concurrent refusal: %v", result.err)
		}
	}
	if success != 1 {
		t.Fatalf("both deletion and a live reference committed: %#v", results)
	}
	graph, err := tasks.Graph(context.Background(), principal, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, task := range graph.Tasks {
		for _, dependency := range task.DependsOn {
			if !slices.ContainsFunc(graph.Tasks, func(candidate core.GraphTask) bool { return candidate.ID == dependency }) {
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
	err := tasks.Delete(ctx, principal, project.ID, task.ID, DeleteTask{Version: task.Version})
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
	completed, err := tasks.SetStatus(context.Background(), principal, project.ID, task.ID, SetTaskStatus{Version: task.Version, Status: core.TaskDone, ClaimID: &task.Properties.Worker.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	before, _, _, _ := deletedTaskStorage(t, database, completed)
	if err := tasks.Delete(context.Background(), principal, project.ID, completed.ID, DeleteTask{Version: completed.Version}); err != nil {
		t.Fatal(err)
	}
	after, _, _, _ := deletedTaskStorage(t, database, completed)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("completed worker history was lost")
	}
}
