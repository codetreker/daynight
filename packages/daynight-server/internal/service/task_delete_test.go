package service

import (
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"errors"
	"io"
	"reflect"
	"slices"
	"strings"
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

func TestTaskDeletionPreservesDataAndReplacesSyncBaseline(t *testing.T) {
	attachments, tasks, database, files, task, principal := attachmentService(t)
	ctx := context.Background()
	pre := finishTask(t, tasks, principal, createTask(t, tasks, principal, task.ProjectID, "Prerequisite"))
	task = updateTask(t, tasks, principal, task, taskcore.UpdateTask{Description: pointer("Preserved body"), DependsOn: pointer([]string{pre.ID}), ExternalDependsOn: pointer([]string{pre.ID}), Properties: propertyPatch(model.PullRequestProperty{URL: "PR", Title: "Retained evidence"})})
	attachment := putAttachment(t, attachments, principal, task, "evidence.txt", "retained bytes")
	before, marker, _, _ := deletedTaskStorage(t, database, task)
	if marker != nil {
		t.Fatal("new task starts deleted")
	}
	sync := taskservice.NewTaskSync(database, time.Second)
	baseline, err := sync.Get(ctx, principal, task.ProjectID, taskservice.TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tasks.Delete(ctx, principal, strings.ToUpper(task.ProjectID), strings.ToUpper(task.ID), taskcore.DeleteTask{Version: task.Version}); err != nil {
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
	object, err := files.Open(ctx, attachmentcore.Bucket, attachmentTestStoragePath(task, attachment.Path))
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "retained bytes" {
		t.Fatalf("attachment bytes changed: %q %v %v", content, readErr, closeErr)
	}
	for _, ready := range []*bool{nil, pointer(true), pointer(false)} {
		page, err := tasks.List(ctx, principal, task.ProjectID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}, Ready: ready})
		if err != nil || slices.ContainsFunc(page.Items, func(item model.Task) bool { return item.ID == task.ID }) {
			t.Fatalf("deleted task is listed: %#v %v", page, err)
		}
	}
	graph, err := tasks.Graph(ctx, principal, task.ProjectID, pre.ID)
	if err != nil || len(graph.Tasks) != 1 || graph.Tasks[0].ID != pre.ID || graph.Summary.Total != 1 {
		t.Fatalf("deleted task counted in graph: %#v %v", graph, err)
	}
	current, err := sync.Get(ctx, principal, task.ProjectID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch, Since: &baseline.ObservedAt})
	if err != nil || current.Mode != "snapshot" || current.Epoch == baseline.Epoch || len(current.Tasks) != 1 || current.Tasks[0].ID != pre.ID {
		t.Fatalf("old caches were not replaced: %#v %v", current, err)
	}
	_, err = tasks.Get(ctx, principal, task.ProjectID, task.ID)
	fault := requireFault(t, err, "task_deleted")
	if !errors.Is(fault, model.ErrTaskDeleted) {
		t.Fatal("deleted task cause lost")
	}
	_, err = tasks.Update(ctx, principal, task.ProjectID, task.ID, taskcore.UpdateTask{Version: version, Title: pointer("Changed")})
	requireFault(t, err, "task_deleted")
	_, err = tasks.SetStatus(ctx, principal, task.ProjectID, task.ID, taskcore.SetTaskStatus{Version: version, Status: model.TaskDone})
	requireFault(t, err, "task_deleted")
	requireFault(t, tasks.Delete(ctx, principal, task.ProjectID, task.ID, taskcore.DeleteTask{Version: version}), "task_deleted")
	_, err = tasks.ClaimWorker(ctx, principal, task.ProjectID, task.ID, taskcore.ClaimWorker{Version: version, WorkerDescriptor: workerDescriptor()})
	requireFault(t, err, "task_deleted")
	_, err = tasks.Create(ctx, principal, task.ProjectID, taskcore.CreateTask{Title: "Invalid reference", DependsOn: []string{task.ID}})
	requireFault(t, err, "invalid_input")
	_, err = attachments.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 100})
	requireFault(t, err, "task_deleted")
	_, _, err = attachments.Open(ctx, principal, task.ProjectID, task.ID, attachment.Path)
	requireFault(t, err, "task_deleted")
	_, _, err = attachments.Put(ctx, principal, task.ProjectID, task.ID, attachment.Path, "text/plain", strings.NewReader("overwrite"))
	requireFault(t, err, "task_deleted")
	requireFault(t, attachments.Delete(ctx, principal, task.ProjectID, task.ID, attachment.Path), "task_deleted")
	// Retained outgoing history must not prevent deleting the former prerequisite.
	if err := tasks.Delete(ctx, principal, task.ProjectID, pre.ID, taskcore.DeleteTask{Version: pre.Version}); err != nil {
		t.Fatal(err)
	}
	graph, err = tasks.Graph(ctx, principal, task.ProjectID, pre.ID)
	requireFault(t, err, "task_deleted")
	if !reflect.DeepEqual(graph, model.TaskGraph{}) {
		t.Fatalf("deleted graph root returned data: %#v", graph)
	}
}
