package postgres

import (
	"context"
	"testing"
)

func TestTaskTypeParentMigrationPreservesResources(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:60]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	first, second := queryID(10), queryID(11)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,description,status,version) VALUES($1,$3,'First','material','done',9),($2,$3,'Second','other','todo',3)`, first, second, project.ID)
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'custom','{"retained":true}')`, first)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, second, first)
	mustQueryExec(t, db, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'evidence.txt','text/plain',7)`, project.ID, first)
	snapshot := func(typed bool) string {
		t.Helper()
		taskExpr := `to_jsonb(t)`
		if typed {
			taskExpr += ` - 'type' - 'parent_id'`
		}
		var result string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(`+taskExpr+` ORDER BY id) FROM tasks t), 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p), 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id) FROM task_dependencies d), 'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path) FROM task_attachments a))::text`).Scan(&result)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := snapshot(false)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(true); after != before {
		t.Fatalf("migration changed existing resources: before=%s after=%s", before, after)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE type='task' AND parent_id IS NULL`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("old rows not task/null: count=%d err=%v", count, err)
	}
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Default')`, queryID(12), project.ID)
	var typ string
	var parent *string
	if err := pool.QueryRow(ctx, `SELECT type,parent_id::text FROM tasks WHERE id=$1`, queryID(12)).Scan(&typ, &parent); err != nil || typ != "task" || parent != nil {
		t.Fatalf("new defaults: type=%q parent=%v err=%v", typ, parent, err)
	}
	for _, name := range []string{"tasks_project_type_created_id", "tasks_project_parent_created_id"} {
		var exists bool
		if err := pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists); err != nil || !exists {
			t.Fatalf("missing index %s: %v", name, err)
		}
	}
}
