package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

// Pre-permission rows receive true through migration; project it explicitly while comparing all historical fields.
func snapshotTaskBeforePermission(t *testing.T, database *Store, projectID, id string) model.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT
  t.id::text,t.project_id::text,t.title,t.description,t.status,t.version,
  t.created_at,t.updated_at,t.started_at,t.completed_at,true,NULL::text,t.properties,`+
		taskDependsOn+`,ARRAY[]::text[],`+taskBlockedBy+`,`+taskReady+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestTaskAgentPermissionMigrationPreservesHistoryAndDefaults(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:10]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	var before []model.Task
	for index, status := range []model.TaskStatus{model.TaskStatus("proposed"), model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		id := queryID(index + 10)
		var started, completed *time.Time
		if status == model.TaskInProgress || status == model.TaskDone {
			start := stamp.Add(time.Minute)
			started = &start
		}
		if status == model.TaskDone {
			end := stamp.Add(2 * time.Minute)
			completed = &end
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,properties)
   VALUES($1,$2,'Historical permission','Preserved',$3,$4,$5,$6,$7,$8,'{"pullRequests":[{"url":"https://example.com/pr/1","title":"Preserved"}]}')`, id, project.ID, status, index+17, stamp, stamp.Add(time.Hour), started, completed)
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, queryID(10), queryID(11))
	for index := range 4 {
		before = append(before, snapshotTaskBeforePermission(t, database, project.ID, queryID(index+10)))
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	for _, original := range before {
		if after := snapshotHistoricalTask(t, database, project.ID, original.ID); !after.AllowAgents || !reflect.DeepEqual(original, after) {
			t.Fatalf("permission migration changed historical resource: before %#v, after %#v", original, after)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'New SQL task')`, queryID(20), project.ID)
	created := snapshotHistoricalTask(t, database, project.ID, queryID(20))
	if created.AllowAgents || created.Status != model.TaskStatus("proposed") || created.Version != 1 || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("new SQL defaults: %#v", created)
	}
	_, err := pool.Exec(ctx, `UPDATE tasks SET allow_agents=NULL WHERE id=$1`, created.ID)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23502" {
		t.Fatalf("null permission bypassed storage: %v", err)
	}
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=11`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=11`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(snapshotHistoricalTask(t, database, project.ID, created.ID), created) {
		t.Fatalf("permission migration rerun changed ledger or new resource: %v", err)
	}
	for _, original := range before {
		if after := snapshotHistoricalTask(t, database, project.ID, original.ID); !reflect.DeepEqual(original, after) {
			t.Fatalf("migration rerun changed history: %#v", after)
		}
	}
}
