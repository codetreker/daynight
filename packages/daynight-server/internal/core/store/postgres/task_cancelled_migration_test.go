package postgres

import (
	"errors"
	"reflect"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func cancellationMigrationRows(t *testing.T, database *Store) []string {
	t.Helper()
	rows, err := database.Pool.Query(t.Context(), `SELECT (to_jsonb(t)-'cancelled_at')::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var row string
		if err := rows.Scan(&row); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func cancellationMigrationFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := statusMigrationRelatedFacts(t, database)
	for name, query := range map[string]string{
		"properties": `SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name)::text FROM task_properties p`,
		"ledger":     `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<46`,
	} {
		var value string
		if err := database.Pool.QueryRow(t.Context(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		facts[name] = value
	}
	return facts
}

func TestCancellationMigrationPreservesHistoricalTasksAndRejectsInconsistentTime(t *testing.T) {
	pool := emptyPool(t)
	previous := schemaMigrations[:len(schemaMigrations)-1]
	if err := migrate(t.Context(), pool, previous); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	for index, status := range []string{"todo", "in_progress", "done"} {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,allow_agents,required_platform,assigned_to,started_at,completed_at)
			VALUES($1,$2,'[Cancelled] retained history','## Preserved',$3,9007199254740993,true,'linux',$4,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`, queryID(index+10), project.ID, status, queryID(5))
	}
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[{"url":"opaque","title":"Original"}]')`, queryID(10))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'nested/proof.md','text/markdown',13)`, project.ID, queryID(10))
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false),($1,$2,$4,true)`, project.ID, queryID(10), queryID(11), queryID(12))
	before, related := cancellationMigrationRows(t, database), cancellationMigrationFacts(t, database)
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cancellationMigrationRows(t, database), before) || !reflect.DeepEqual(cancellationMigrationFacts(t, database), related) {
		t.Fatal("cancellation migration changed existing task data or related resources")
	}
	var nonnull int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM tasks WHERE cancelled_at IS NOT NULL`).Scan(&nonnull); err != nil || nonnull != 0 {
		t.Fatalf("historical task received cancellation time: %d %v", nonnull, err)
	}
	for _, mutation := range []string{
		`UPDATE tasks SET status='cancelled' WHERE id=$1`,
		`UPDATE tasks SET cancelled_at=statement_timestamp() WHERE id=$1`,
		`UPDATE tasks SET status='cancel',cancelled_at=statement_timestamp() WHERE id=$1`,
	} {
		_, err := pool.Exec(t.Context(), mutation, queryID(10))
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" {
			t.Fatalf("inconsistent cancellation state was not rejected: %v", err)
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET status='cancelled',cancelled_at=statement_timestamp() WHERE id=$1`, queryID(10))
	var original string
	if err := pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, queryID(10)).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var repeated string
	if err := pool.QueryRow(t.Context(), `SELECT to_jsonb(t)::text FROM tasks t WHERE id=$1`, queryID(10)).Scan(&repeated); err != nil || repeated != original {
		t.Fatalf("repeat changed cancellation data: %v", err)
	}
}

func TestCancellationMigrationFailureRollsBackColumnConstraintAndLedger(t *testing.T) {
	pool := emptyPool(t)
	previous := schemaMigrations[:len(schemaMigrations)-1]
	if err := migrate(t.Context(), pool, previous); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Preserved')`, queryID(10), project.ID)
	before := cancellationMigrationRows(t, database)
	mustQueryExec(t, database, `CREATE FUNCTION reject_cancellation_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.version=46 THEN RAISE EXCEPTION USING ERRCODE='P1046',MESSAGE='ledger rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_cancellation_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_cancellation_ledger()`)
	err := migrate(t.Context(), pool, schemaMigrations)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1046" {
		t.Fatalf("migration lost ledger failure: %v", err)
	}
	var columns, ledger int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='cancelled_at'`).Scan(&columns); err != nil || columns != 0 {
		t.Fatalf("failed migration retained new column: %d %v", columns, err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM schema_migrations WHERE version=46`).Scan(&ledger); err != nil || ledger != 0 || !reflect.DeepEqual(cancellationMigrationRows(t, database), before) {
		t.Fatalf("failed migration partially changed data/ledger: %d %v", ledger, err)
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_cancellation_ledger ON schema_migrations; DROP FUNCTION reject_cancellation_ledger()`)
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatalf("migration failed after repairing cause: %v", err)
	}
}
