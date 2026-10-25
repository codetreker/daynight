package service

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
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
	target = updateTask(t, tasks, principal, target, UpdateTask{DependsOn: pointer([]string{outgoing.ID})})
	target = finishTask(t, tasks, principal, target)
	putAttachment(t, attachments, principal, target, "evidence.txt", "preserved")
	var sources []core.Task
	for _, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
		source := createTask(t, tasks, principal, projectID, "Source", target.ID, unrelated.ID)
		source = updateTask(t, tasks, principal, source, UpdateTask{ExternalDependsOn: pointer([]string{target.ID, unrelated.ID}), Properties: propertyPatch(core.PullRequestProperty{URL: "Evidence", Title: "Preserved"})})
		sources = append(sources, setStatusTask(t, tasks, principal, source, status))
	}
	worker := claimableTask(t, tasks, principal, projectID)
	worker = updateTask(t, tasks, principal, worker, UpdateTask{DependsOn: pointer([]string{target.ID, unrelated.ID})})
	sources = append(sources, claimWorkerTask(t, tasks, principal, worker, workerDescriptor()))
	historical := createTask(t, tasks, principal, projectID, "Deleted source", target.ID, unrelated.ID)
	if err := tasks.Delete(ctx, principal, projectID, historical.ID, DeleteTask{Version: historical.Version}); err != nil {
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
	sync := NewTaskSync(database, time.Second)
	baseline, err := sync.Get(ctx, principal, projectID, TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tasks.Delete(ctx, principal, projectID, target.ID, DeleteTask{Version: target.Version, RemoveDepends: true}); err != nil {
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
	for _, preserved := range []core.Task{outgoing, unrelated} {
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
	_, err = tasks.Update(ctx, principal, projectID, sources[0].ID, UpdateTask{Version: sources[0].Version, Title: pointer("Stale update")})
	requireFault(t, err, "version_conflict")
	after, err := sync.Get(ctx, principal, projectID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &baseline.ObservedAt})
	if err != nil || after.Mode != "snapshot" || after.Epoch == baseline.Epoch || slices.ContainsFunc(after.Tasks, func(task core.TaskViewRecord) bool { return task.ID == target.ID }) {
		t.Fatalf("cache baseline did not reflect deletion: %#v %v", after, err)
	}
	for _, source := range sources[:len(sources)-1] {
		index := slices.IndexFunc(after.Tasks, func(task core.TaskViewRecord) bool { return task.ID == source.ID })
		if index < 0 || after.Tasks[index].Version != before[source.ID].version+1 || !slices.Equal(after.Tasks[index].DependsOn, []string{unrelated.ID}) {
			t.Fatal("source version and relationships were not included in replacement snapshot")
		}
	}
}

func TestTaskDeletionRemoveDependsWithoutReferences(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "No references")
	if err := tasks.Delete(context.Background(), principal, project.ID, task.ID, DeleteTask{Version: task.Version, RemoveDepends: true}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskDeletionRemoveDependsRefusalsAndFailuresAreAtomic(t *testing.T) {
	for _, scenario := range []string{"stale", "target-worker", "unauthorized", "epoch", "source-overflow"} {
		t.Run(scenario, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			ctx := context.Background()
			target := createTask(t, tasks, principal, project.ID, "Target")
			if scenario == "target-worker" {
				target = updateTask(t, tasks, principal, target, UpdateTask{AllowAgents: pointer(true)})
				target = claimWorkerTask(t, tasks, principal, target, workerDescriptor())
			}
			source := createTask(t, tasks, principal, project.ID, "Dependent", target.ID)
			caller, version := principal, target.Version
			code := ""
			switch scenario {
			case "stale":
				version++
				code = "version_conflict"
			case "target-worker":
				code = "invalid_transition"
			case "unauthorized":
				caller = servicePrincipal(t, database)
				code = "not_found"
			case "epoch":
				if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION reject_dependency_delete_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN RAISE EXCEPTION 'epoch rotation failed'; END $$;
					CREATE TRIGGER reject_dependency_delete_epoch BEFORE UPDATE OF task_cache_epoch ON projects
					FOR EACH ROW EXECUTE FUNCTION reject_dependency_delete_epoch()`); err != nil {
					t.Fatal(err)
				}
			case "source-overflow":
				if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET version=9223372036854775807 WHERE id=$1", source.ID); err != nil {
					t.Fatal(err)
				}
			}
			before := taskDeleteProjectFacts(t, database, project.ID)
			err := tasks.Delete(ctx, caller, project.ID, target.ID, DeleteTask{Version: version, RemoveDepends: true})
			if code == "" {
				if err == nil {
					t.Fatal("SQL failure was hidden")
				}
			} else {
				requireFault(t, err, code)
			}
			if after := taskDeleteProjectFacts(t, database, project.ID); before != after {
				t.Fatalf("failed operation committed partial data: %s -> %s", before, after)
			}
		})
	}
}

func TestTaskDeletionRemoveDependsConcurrentSourceUpdateUsesVersion(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	source := createTask(t, tasks, principal, project.ID, "Source", target.ID)
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return core.Task{}, tasks.Delete(ctx, principal, project.ID, target.ID, DeleteTask{Version: target.Version, RemoveDepends: true})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.Update(ctx, principal, project.ID, source.ID, UpdateTask{Version: source.Version, Title: pointer("Changed")})
		})
	updated, deleted := false, false
	for _, result := range results {
		if result.err != nil {
			requireFault(t, result.err, "version_conflict")
		} else if result.task.ID == source.ID {
			updated = true
		} else {
			deleted = true
		}
	}
	if !deleted {
		t.Fatal("deletion should succeed in either serialized order")
	}
	current, err := tasks.Get(context.Background(), principal, project.ID, source.ID)
	if err != nil || len(current.DependsOn) != 0 {
		t.Fatalf("dangling source after concurrent update: %#v %v", current, err)
	}
	want := source.Version + 1
	if updated {
		want++
	}
	if current.Version != want {
		t.Fatal("source CAS or version increment was lost")
	}
}

func TestTaskDeletionRemoveDependsSerializesWithNewSource(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	target := createTask(t, tasks, principal, project.ID, "Target")
	results := competeTaskWrites(t, database, project.ID,
		func(ctx context.Context) (core.Task, error) {
			return core.Task{}, tasks.Delete(ctx, principal, project.ID, target.ID, DeleteTask{Version: target.Version, RemoveDepends: true})
		},
		func(ctx context.Context) (core.Task, error) {
			return tasks.Create(ctx, principal, project.ID, CreateTask{Title: "New source", DependsOn: []string{target.ID}})
		})
	// The lock order may admit creation before deletion, in which case both writes succeed.
	for _, result := range results {
		if result.err != nil {
			requireFault(t, result.err, "invalid_input")
		} else if result.task.ID != "" {
			current, err := tasks.Get(context.Background(), principal, project.ID, result.task.ID)
			if err != nil || len(current.DependsOn) != 0 || current.Version != result.task.Version+1 || !current.Ready {
				t.Fatalf("creation committed first without subsequent relationship removal: %#v %v", current, err)
			}
		}
	}
	_, marker, _, _ := deletedTaskStorage(t, database, target)
	if marker == nil {
		t.Fatal("deletion did not commit in either serialized order")
	}
	var edges int
	if err := database.Pool.QueryRow(context.Background(), "SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=$2", project.ID, target.ID).Scan(&edges); err != nil || edges != 0 {
		t.Fatalf("new source survived with a dangling edge: %d %v", edges, err)
	}
}
