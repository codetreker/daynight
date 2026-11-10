package postgres

import (
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTaskProposedStateMigrationPreservesFourStateResources(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:59]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	prerequisite := queryTask(t, database, project.ID, 9, model.TaskDone)
	before := make([]model.Task, 0, 4)
	for index, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		current := queryTask(t, database, project.ID, index+10, status, prerequisite.ID)
		mustQueryExec(t, database, `UPDATE tasks SET version=$2,description='Retained description',allow_agents=true,
 started_at=CASE WHEN status IN ('in_progress','done') THEN '2026-01-01T10:00:00Z'::timestamptz ELSE NULL END,
 completed_at=CASE WHEN status='done' THEN '2026-01-01T11:00:00Z'::timestamptz ELSE NULL END WHERE id=$1`, current.ID, index+20)
		mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[{"url":"https://example.test/pr/1","title":"Retained"}]')`, current.ID)
		mustQueryExec(t, database, `UPDATE task_dependencies SET external=true WHERE task_id=$1`, current.ID)
		before = append(before, snapshotTask(t, database, project.ID, current.ID))
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	for _, current := range before {
		if after := snapshotTask(t, database, project.ID, current.ID); !reflect.DeepEqual(after, current) {
			t.Fatalf("proposed migration changed existing task: before=%+v after=%+v", current, after)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Default proposed')`, queryID(30), project.ID)
	created := snapshotTask(t, database, project.ID, queryID(30))
	if created.Status != model.TaskProposed || created.Ready || created.Version != 1 || created.StartedAt != nil || created.CompletedAt != nil || created.CancelledAt != nil {
		t.Fatalf("new default did not create an unstarted proposed task: %+v", created)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Confirmed todo','todo')`, queryID(31), project.ID)
	if explicit := snapshotTask(t, database, project.ID, queryID(31)); explicit.Status != model.TaskTodo || !explicit.Ready {
		t.Fatalf("explicit todo lost executable status: %+v", explicit)
	}
	var applied string
	if err := pool.QueryRow(ctx, `SELECT applied_at::text FROM schema_migrations WHERE version=60`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var reapplied string
	if err := pool.QueryRow(ctx, `SELECT applied_at::text FROM schema_migrations WHERE version=60`).Scan(&reapplied); err != nil || applied != reapplied {
		t.Fatalf("migration replay changed its ledger: before=%s after=%s err=%v", applied, reapplied, err)
	}
}
