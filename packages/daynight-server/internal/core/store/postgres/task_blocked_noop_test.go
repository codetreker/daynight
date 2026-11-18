package postgres

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestMigratedBlockedWhitespaceSetIsNoOp(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:len(schemaMigrations)-1]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	var user string
	if err := pool.QueryRow(ctx, `SELECT user_id::text FROM project_grants WHERE project_id=$1 AND role='admin' LIMIT 1`, project.ID).Scan(&user); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: queryID(99)}
	for i, v := range []string{"true", "false"} {
		id := queryID(10 + i)
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,status,version,created_at,updated_at) VALUES($1,$2,'Task','todo',17,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z')`, id, project.ID)
		mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused',$2)`, id, " \n"+v+" ")
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	svc := taskservice.NewTasks(db)
	for i, v := range []string{"true", "false"} {
		id := queryID(10 + i)
		before, err := svc.Get(ctx, principal, project.ID, id)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"paused", "blocked"} {
			got, err := svc.SetProperty(ctx, principal, project.ID, id, name, v, before.Version)
			if err != nil || got.Version != before.Version || !got.UpdatedAt.Equal(before.UpdatedAt) {
				t.Fatalf("%s %s: %#v %v", name, v, got, err)
			}
		}
		var raw string
		var version int64
		if err := pool.QueryRow(ctx, `SELECT p.value,t.version FROM tasks t JOIN task_properties p ON p.task_id=t.id AND p.name='blocked' WHERE t.id=$1`, id).Scan(&raw, &version); err != nil || raw != " \n"+v+" " || version != before.Version {
			t.Fatalf("persisted: %q %d %v", raw, version, err)
		}
	}
}
