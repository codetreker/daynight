package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"

	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func taskDeleteProjectFacts(t *testing.T, database *postgres.Store, projectID string) string {
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

func TestTaskDeletionRemoveDependsWithoutReferences(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	task := createTask(t, tasks, principal, project.ID, "No references")
	if err := tasks.Delete(context.Background(), principal, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version, RemoveDepends: true}); err != nil {
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
				target = updateTask(t, tasks, principal, target, taskcore.UpdateTask{AssignedTo: assignmentChange(&principal.UserID)})
				target = updateTask(t, tasks, principal, target, taskcore.UpdateTask{AllowAgents: pointer(true)})
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
			err := tasks.Delete(ctx, caller, project.ID, target.ID, taskcore.DeleteTask{Version: version, RemoveDepends: true})
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
		func(ctx context.Context) (model.Task, error) {
			return model.Task{}, tasks.Delete(ctx, principal, project.ID, target.ID, taskcore.DeleteTask{Version: target.Version, RemoveDepends: true})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Update(ctx, principal, project.ID, source.ID, taskcore.UpdateTask{Version: source.Version, Title: pointer("Changed")})
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
		func(ctx context.Context) (model.Task, error) {
			return model.Task{}, tasks.Delete(ctx, principal, project.ID, target.ID, taskcore.DeleteTask{Version: target.Version, RemoveDepends: true})
		},
		func(ctx context.Context) (model.Task, error) {
			return tasks.Create(ctx, principal, project.ID, taskcore.CreateTask{Title: "New source", DependsOn: []string{target.ID}})
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
