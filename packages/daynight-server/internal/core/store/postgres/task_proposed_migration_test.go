package postgres

import (
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
	prerequisite := queryID(9)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Prerequisite','done')`, prerequisite, project.ID)
	for index, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		id := queryID(index + 10)
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,allow_agents,started_at,completed_at,cancelled_at)
 VALUES($1,$2,'Task','Retained description',$3,$4,true,
 CASE WHEN $3 IN ('in_progress','done') THEN '2026-01-01T10:00:00Z'::timestamptz ELSE NULL END,
 CASE WHEN $3='done' THEN '2026-01-01T11:00:00Z'::timestamptz ELSE NULL END,
 CASE WHEN $3='cancelled' THEN '2026-01-01T12:00:00Z'::timestamptz ELSE NULL END)`, id, project.ID, status, index+20)
		mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[{"url":"https://example.test/pr/1","title":"Retained"}]')`, id)
		mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, id, prerequisite)
	}
	snapshot := func() string {
		t.Helper()
		var result string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t)-'type'-'parent_id' ORDER BY id) FROM tasks t), 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p), 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id) FROM task_dependencies d))::text`).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := snapshot()
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(); after != before {
		t.Fatalf("proposed migration changed existing resources: before=%s after=%s", before, after)
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
