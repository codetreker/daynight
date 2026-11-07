package service

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func threadWait(t *testing.T, ctx context.Context, condition func() (bool, error)) {
	t.Helper()
	for {
		ok, err := condition()
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func stepsStoredState(t *testing.T, database *store.Store, taskID string, excludeParentRevision bool) string {
	t.Helper()
	var state string
	err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
 'task',(SELECT CASE WHEN $2 THEN to_jsonb(t)-'version'-'updated_at' ELSE to_jsonb(t) END FROM tasks t WHERE id=$1),
 'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=$1),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, taskID, excludeParentRevision).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func workerDescriptor() taskcore.WorkerDescriptor {
	return taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Build machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, WorktreeID: uuid.NewString()}
}

func workerMember(t *testing.T, database *store.Store, projectID string) model.Principal {
	t.Helper()
	principal := servicePrincipal(t, database)
	if err := writeProjectForTest(database, context.Background(), projectID, func(tx store.ProjectWriteScope) error {
		_, err := tx.ProjectDAO().AddInvitedMember(context.Background(), principal.UserID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return principal
}

func claimableTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, projectID string) model.Task {
	t.Helper()
	created, err := tasks.Create(context.Background(), principal, projectID, taskcore.CreateTask{Title: "Worker task", AssignedTo: &principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	return updateTask(t, tasks, principal, created, taskcore.UpdateTask{AllowAgents: pointer(true)})
}

func claimWorkerTask(t *testing.T, tasks *taskservice.Tasks, principal model.Principal, task model.Task, descriptor taskcore.WorkerDescriptor) model.Task {
	t.Helper()
	claimed, err := tasks.ClaimWorker(context.Background(), principal, task.ProjectID, task.ID, taskcore.ClaimWorker{Version: task.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	return claimed
}

func postThread(t *testing.T, threads *taskservice.TaskThreads, principal model.Principal, task model.Task, input taskservice.CreateThreadMessage) taskservice.ThreadMessageDocument {
	t.Helper()
	result, err := threads.Post(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	var resource api.ThreadMessage
	if err := json.Unmarshal(result.JSON, &resource); err != nil || resource.ID != result.Message.ID || resource.Body != input.Body {
		t.Fatalf("message document: %#v, %v", resource, err)
	}
	return result
}
func listThread(t *testing.T, threads *taskservice.TaskThreads, principal model.Principal, task model.Task, input taskservice.ThreadListRequest) taskservice.ThreadPageDocument {
	t.Helper()
	result, err := threads.List(context.Background(), principal, task.ProjectID, task.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	var resource api.ThreadPage
	if err := json.Unmarshal(result.JSON, &resource); err != nil || len(resource.Items) != len(result.Page.Items) || len(result.JSON) > taskcodec.PageLimit {
		t.Fatalf("page document: %#v, %v", resource, err)
	}
	return result
}
func seedGraph(t *testing.T, database *store.Store, projectID string, nodes, edges int) {
	t.Helper()
	ctx := context.Background()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
		SELECT md5($1::text || ':' || n)::uuid, $1::uuid, 'Task ' || n, '', 'todo', 1,
		statement_timestamp() + n * interval '1 microsecond', statement_timestamp()
		FROM generate_series(1, $2::int) n`, projectID, nodes); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
		SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
		FROM generate_series(1, $2::int) target CROSS JOIN generate_series(1, $2::int) predecessor
		WHERE predecessor < target ORDER BY target, predecessor LIMIT $3`, projectID, nodes, edges); err != nil {
		t.Fatal(err)
	}
}
func seedConnectedGraph(t *testing.T, database *store.Store, projectID string, nodes, edges int) string {
	t.Helper()
	ctx := context.Background()
	seedGraph(t, database, projectID, nodes, 0)
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || n)::uuid, md5($1::text || ':' || (n-1))::uuid
  FROM generate_series(2, $2::int) n`, projectID, nodes); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
  SELECT $1::uuid, md5($1::text || ':' || target)::uuid, md5($1::text || ':' || predecessor)::uuid
  FROM generate_series(1, $2::int) target CROSS JOIN generate_series(1, $2::int) predecessor
  WHERE predecessor < target-1 ORDER BY target, predecessor LIMIT $3`, projectID, nodes, edges-(nodes-1)); err != nil {
		t.Fatal(err)
	}
	// Bulk graph queries need statistics before autovacuum analyzes the fixture.
	if _, err := database.Pool.Exec(ctx, `ANALYZE tasks, task_dependencies`); err != nil {
		t.Fatal(err)
	}
	var rootID string
	if err := database.Pool.QueryRow(ctx, `SELECT md5($1::text || ':1')::uuid::text`, projectID).Scan(&rootID); err != nil {
		t.Fatal(err)
	}
	return rootID
}

func assignmentChange(value *string) **string { return &value }
func createAssignedTask(t *testing.T, tasks *taskservice.Tasks, actor model.Principal, projectID string, assigned *string) model.Task {
	t.Helper()
	created, err := tasks.Create(context.Background(), actor, projectID, taskcore.CreateTask{
		Title: "Assigned responsibility", Description: "Preserved material", AssignedTo: assigned,
		Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00", Title: "Evidence"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func platformChange(value *model.TaskPlatform) **model.TaskPlatform { return &value }
