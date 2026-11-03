package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskPlatformMigrationPreservesHistoryAndConstrainsValues(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	for index, status := range []core.TaskStatus{core.TaskStatus("proposed"), core.TaskTodo, core.TaskInProgress, core.TaskDone} {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,allow_agents,properties)
		 VALUES($1,$2,'Platform history','Preserved',$3,$4,$5,$6,$5,$6,$7,'{"pullRequests":[{"url":"https://example.com/pr/1","title":"Preserved"}]}')`, queryID(index+10), project.ID, status, index+17, stamp, stamp.Add(time.Hour), index%2 == 0)
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, queryID(11), queryID(13))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'plan.md','text/markdown',123)`, project.ID, queryID(11))
	facts := func() map[string]string {
		result := make(map[string]string)
		for name, query := range map[string]string{
			"tasks":        `SELECT jsonb_agg(to_jsonb(t)-'required_platform' ORDER BY id)::text FROM tasks t`,
			"dependencies": `SELECT jsonb_agg(to_jsonb(t) ORDER BY task_id)::text FROM task_dependencies t`,
			"attachments":  `SELECT jsonb_agg(to_jsonb(t) ORDER BY task_id)::text FROM task_attachments t`,
			"ledger":       `SELECT jsonb_agg(to_jsonb(t) ORDER BY version)::text FROM schema_migrations t WHERE version<=12`,
		} {
			var value string
			if err := pool.QueryRow(ctx, query).Scan(&value); err != nil {
				t.Fatal(err)
			}
			result[name] = value
		}
		return result
	}
	read := func(id string) core.Task {
		t.Helper()
		task, err := scanHistoricalTask(pool.QueryRow(ctx, `SELECT `+historicalPlatformTaskProjection+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, project.ID, id))
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	before := facts()
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, facts()) {
		t.Fatal("platform migration changed historical facts")
	}
	for index := range 4 {
		if read(queryID(index+10)).RequiredPlatform != nil {
			t.Fatal("historical task acquired a platform requirement")
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Unrestricted new task')`, queryID(20), project.ID)
	created := read(queryID(20))
	if created.RequiredPlatform != nil || created.AllowAgents || created.Status != core.TaskStatus("proposed") || created.Ready || created.Version != 1 {
		t.Fatalf("new defaults: %#v", created)
	}
	for _, platform := range []string{"windows", "linux", "macos", "", "darwin", "Windows"} {
		_, err := pool.Exec(ctx, `UPDATE tasks SET required_platform=$1 WHERE id=$2`, platform, created.ID)
		if core.TaskPlatform(platform).Valid() {
			if err != nil {
				t.Fatal(err)
			}
			if actual := read(created.ID).RequiredPlatform; actual == nil || string(*actual) != platform {
				t.Fatal("storage lost required platform")
			}
		} else {
			var constraint *pgconn.PgError
			if !errors.As(err, &constraint) || constraint.Code != "23514" {
				t.Fatalf("invalid platform bypassed storage: %v", err)
			}
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET required_platform=NULL WHERE id=$1`, created.ID)
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=13`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=13`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(created, read(created.ID)) {
		t.Fatalf("repeated migration changed ledger or resource: %v", err)
	}
}
