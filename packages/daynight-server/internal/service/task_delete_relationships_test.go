package service

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func taskDeleteProjectFacts(t *testing.T, database *store.Store, projectID string) string {
	t.Helper()
	var facts string
	if err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
		'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t WHERE project_id=$1),
		'edges',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id),'[]'::jsonb) FROM task_dependencies d WHERE project_id=$1),
		'epoch',(SELECT task_cache_epoch FROM projects WHERE id=$1))::text`, projectID).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func TestTaskDeletionRemovesIncomingRelationshipsAndPreservesSourceFacts(t *testing.T) {
	attachments, tasks, database, _, target, principal := attachmentService(t)
	ctx := context.Background()
	projectID := target.ProjectID
	outgoing := finishTask(t, tasks, principal, createTask(t, tasks, principal, projectID, "Target prerequisite"))
	unrelated := finishTask(t, tasks, principal, createTask(t, tasks, principal, projectID, "Unrelated prerequisite"))
	target = updateTask(t, tasks, principal, target, taskcore.UpdateTask{DependsOn: pointer([]string{outgoing.ID})})
	target = finishTask(t, tasks, principal, target)
	putAttachment(t, attachments, principal, target, "evidence.txt", "preserved")
	var sources []model.Task
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		source := createTask(t, tasks, principal, projectID, "Source", target.ID, unrelated.ID)
		source = updateTask(t, tasks, principal, source, taskcore.UpdateTask{ExternalDependsOn: pointer([]string{target.ID, unrelated.ID}), Properties: propertyPatch(model.PullRequestProperty{URL: "Evidence", Title: "Preserved"})})
		sources = append(sources, setStatusTask(t, tasks, principal, source, status))
	}
	worker := claimableTask(t, tasks, principal, projectID)
	worker = updateTask(t, tasks, principal, worker, taskcore.UpdateTask{DependsOn: pointer([]string{target.ID, unrelated.ID})})
	sources = append(sources, claimWorkerTask(t, tasks, principal, worker, workerDescriptor()))
	historical := createTask(t, tasks, principal, projectID, "Deleted source", target.ID, unrelated.ID)
	if err := tasks.Delete(ctx, principal, projectID, historical.ID, taskcore.DeleteTask{Version: historical.Version}); err != nil {
		t.Fatal(err)
	}
	sources = append(sources, historical)
	type facts struct {
		data    string
		marker  *time.Time
		updated time.Time
		version int64
	}
	before := make(map[string]facts)
	for _, source := range append(slices.Clone(sources), target, outgoing, unrelated) {
		data, marker, updated, version := deletedTaskStorage(t, database, source)
		before[source.ID] = facts{data, marker, updated, version}
	}
	sync := taskservice.NewTaskSync(database, time.Second)
	baseline, err := sync.Get(ctx, principal, projectID, taskservice.TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tasks.Delete(ctx, principal, projectID, target.ID, taskcore.DeleteTask{Version: target.Version, RemoveDepends: true}); err != nil {
		t.Fatal(err)
	}
	for _, source := range sources {
		data, marker, updated, version := deletedTaskStorage(t, database, source)
		old := before[source.ID]
		if data != old.data || !reflect.DeepEqual(marker, old.marker) || version != old.version+1 || !updated.After(old.updated) {
			t.Fatalf("source %s lost stored state or did not advance once: marker %v -> %v version %d -> %d", source.ID, old.marker, marker, old.version, version)
		}
		var depends, external []string
		if err := database.Pool.QueryRow(ctx, `SELECT
			ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE project_id=$1 AND task_id=$2 ORDER BY depends_on_task_id),
			ARRAY(SELECT depends_on_task_id::text FROM task_dependencies WHERE project_id=$1 AND task_id=$2 AND external ORDER BY depends_on_task_id)`, projectID, source.ID).Scan(&depends, &external); err != nil || !slices.Equal(depends, []string{unrelated.ID}) {
			t.Fatalf("unrelated source relationships changed: %v %v", depends, err)
		}
		if len(source.ExternalDependsOn) != 0 && !slices.Equal(external, []string{unrelated.ID}) {
			t.Fatal("unrelated external classification was discarded")
		}
	}
	for _, preserved := range []model.Task{outgoing, unrelated} {
		data, marker, updated, version := deletedTaskStorage(t, database, preserved)
		old := before[preserved.ID]
		if data != old.data || !reflect.DeepEqual(marker, old.marker) || updated != old.updated || version != old.version {
			t.Fatal("an unrelated task was changed")
		}
	}
	data, marker, updated, version := deletedTaskStorage(t, database, target)
	if data != before[target.ID].data || marker == nil || !marker.Equal(updated) || version != target.Version+1 {
		t.Fatal("target deletion changed original fields or advanced its version incorrectly")
	}
	var incoming, outgoingCount, attachmentCount int
	if err := database.Pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=$2),
		(SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND task_id=$2),
		(SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$2)`, projectID, target.ID).Scan(&incoming, &outgoingCount, &attachmentCount); err != nil || incoming != 0 || outgoingCount != 1 || attachmentCount != 1 {
		t.Fatalf("wrong deletion scope: incoming=%d outgoing=%d attachments=%d err=%v", incoming, outgoingCount, attachmentCount, err)
	}
	_, err = tasks.Update(ctx, principal, projectID, sources[0].ID, taskcore.UpdateTask{Version: sources[0].Version, Title: pointer("Stale update")})
	requireFault(t, err, "version_conflict")
	after, err := sync.Get(ctx, principal, projectID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch, Since: &baseline.ObservedAt})
	if err != nil || after.Mode != "snapshot" || after.Epoch == baseline.Epoch || slices.ContainsFunc(after.Tasks, func(task model.TaskViewRecord) bool { return task.ID == target.ID }) {
		t.Fatalf("cache baseline did not reflect deletion: %#v %v", after, err)
	}
	for _, source := range sources[:len(sources)-1] {
		index := slices.IndexFunc(after.Tasks, func(task model.TaskViewRecord) bool { return task.ID == source.ID })
		if index < 0 || after.Tasks[index].Version != before[source.ID].version+1 || !slices.Equal(after.Tasks[index].DependsOn, []string{unrelated.ID}) {
			t.Fatal("source version and relationships were not included in replacement snapshot")
		}
	}
}
