package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type workerMigrationRow struct {
	ID         string
	Properties string
	OtherFacts string
}

func workerMigrationRows(t *testing.T, database *Store) []workerMigrationRow {
	t.Helper()
	rows, err := database.Pool.Query(context.Background(), `SELECT id::text,properties,(to_jsonb(t)-'properties')::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := []workerMigrationRow{}
	for rows.Next() {
		var row workerMigrationRow
		if err := rows.Scan(&row.ID, &row.Properties, &row.OtherFacts); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func workerMigrationRelatedFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := make(map[string]string)
	for name, query := range map[string]string{
		"projects":     `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text FROM projects t`,
		"attachments":  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,path),'[]'::jsonb)::text FROM task_attachments t`,
		"dependencies": `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id,task_id,depends_on_task_id),'[]'::jsonb)::text FROM task_dependencies t`,
		"ledger":       `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=15`,
	} {
		var value string
		if err := database.Pool.QueryRow(context.Background(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		facts[name] = value
	}
	return facts
}

func TestWorkerMigrationPreservesOpaquePropertiesAndExecutionFacts(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:15]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 10, 24, 1, 2, 3, 123456000, time.UTC)
	properties := []struct{ before, after string }{
		{`{"pullRequests":[]}`, `{"pullRequests":[],"worker":null}`},
		{`{"pullRequests":[{"url":"\u0000","title":"\ud800"}]}`, `{"pullRequests":[{"url":"\u0000","title":"\ud800"}],"worker":null}`},
		{`{"pullRequests":[{"url":"https://example.com/{path}","title":"} quote\" slash\\ 中文"}]}`, `{"pullRequests":[{"url":"https://example.com/{path}","title":"} quote\" slash\\ 中文"}],"worker":null}`},
		{"{\"pullRequests\":[]} \t\n", "{\"pullRequests\":[],\"worker\":null} \t\n"},
	}
	for index, value := range properties {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,allow_agents,required_platform,properties)
			VALUES($1,$2,'Preserved worker input','## Complete Markdown\nPreserved body',$3,$4,$5,$6,$5,$6,$7,$8,$9)`,
			queryID(index+10), project.ID, []string{"todo", "in_progress", "done", "todo"}[index], int64(9007199254740993)+int64(index), stamp, stamp.Add(time.Hour), index%2 == 0, []any{nil, "linux", "macos", "windows"}[index], value.before)
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, queryID(10), queryID(12))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'plan.md','text/markdown',123)`, project.ID, queryID(10))
	before, facts := workerMigrationRows(t, database), workerMigrationRelatedFacts(t, database)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	after := workerMigrationRows(t, database)
	if len(after) != len(before) || !reflect.DeepEqual(workerMigrationRelatedFacts(t, database), facts) {
		t.Fatal("worker migration changed task inventory or related resources")
	}
	for index, original := range before {
		expected := original
		expected.Properties = properties[index].after
		if !reflect.DeepEqual(after[index], expected) {
			t.Fatalf("migration changed opaque PR bytes or execution facts: expected %#v actual %#v", expected, after[index])
		}
	}
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=16`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=16`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(workerMigrationRows(t, database), after) {
		t.Fatalf("repeated worker migration changed rows or ledger: %v", err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'New task')`, queryID(30), project.ID)
	var created string
	if err := pool.QueryRow(ctx, `SELECT properties FROM tasks WHERE id=$1`, queryID(30)).Scan(&created); err != nil || created != `{"pullRequests":[],"worker":null}` {
		t.Fatalf("new task lacks explicit null worker default: %q %v", created, err)
	}
	current := snapshotTask(t, database, project.ID, queryID(30))
	if current.Properties.Worker != nil || current.Properties.PullRequests == nil {
		t.Fatalf("new task did not decode strict empty properties: %#v", current)
	}
}

func TestWorkerMigrationRollsBackPropertiesDefaultAndLedger(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:15]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,properties) VALUES($1,$2,'Preserved','{"pullRequests":[{"url":"\u0000","title":"\ud800"}]}')`, queryID(10), project.ID)
	mustQueryExec(t, database, `CREATE FUNCTION reject_worker_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.version=16 THEN RAISE EXCEPTION USING ERRCODE='P1016', MESSAGE='worker ledger rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_worker_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_worker_ledger()`)
	before, facts := workerMigrationRows(t, database), workerMigrationRelatedFacts(t, database)
	err := migrate(ctx, pool, schemaMigrations)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1016" {
		t.Fatalf("worker migration lost the ledger failure: %v", err)
	}
	if !reflect.DeepEqual(workerMigrationRows(t, database), before) || !reflect.DeepEqual(workerMigrationRelatedFacts(t, database), facts) {
		t.Fatal("failed worker migration partially changed rows or related resources")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=16`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed worker migration retained its ledger: %d %v", count, err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Old default')`, queryID(11), project.ID)
	var originalDefault string
	if err := pool.QueryRow(ctx, `SELECT properties FROM tasks WHERE id=$1`, queryID(11)).Scan(&originalDefault); err != nil || originalDefault != `{"pullRequests":[]}` {
		t.Fatalf("failed worker migration changed default: %q %v", originalDefault, err)
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_worker_ledger ON schema_migrations; DROP FUNCTION reject_worker_ledger()`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("worker migration could not succeed after failure removal: %v", err)
	}
	rows := workerMigrationRows(t, database)
	if rows[0].Properties != `{"pullRequests":[{"url":"\u0000","title":"\ud800"}],"worker":null}` || rows[1].Properties != `{"pullRequests":[],"worker":null}` {
		t.Fatalf("repaired migration did not add worker exactly once: %#v", rows)
	}
}
