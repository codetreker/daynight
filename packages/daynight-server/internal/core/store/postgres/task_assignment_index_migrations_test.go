package postgres

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskAssignmentAllIndexMigration(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	if err := migrate(ctx, pool, schemaMigrations[:62]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,assigned_to,deleted_at)
		VALUES($1,$3,'Visible',$4,NULL),($2,$3,'Deleted',$4,statement_timestamp())`,
		queryID(10), queryID(11), project.ID, queryID(20))
	var before string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	// An incomplete ledger write must roll back the index with the migration.
	mustQueryExec(t, database, `CREATE FUNCTION reject_assignment_index_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.version=63 THEN RAISE EXCEPTION USING ERRCODE='P1063', MESSAGE='ledger rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_assignment_index_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_assignment_index_ledger()`)
	err := migrate(ctx, pool, schemaMigrations)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1063" {
		t.Fatalf("migration lost ledger failure: %v", err)
	}
	var newIndex *string
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT to_regclass('tasks_project_assigned_to_created_id_all')::text,
		(SELECT count(*) FROM schema_migrations WHERE version=63)`).Scan(&newIndex, &ledger); err != nil || newIndex != nil || ledger != 0 {
		t.Fatalf("failed migration retained index or ledger: %v %d %v", newIndex, ledger, err)
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_assignment_index_ledger ON schema_migrations; DROP FUNCTION reject_assignment_index_ledger()`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("migration failed after repairing cause: %v", err)
	}
	for name, predicate := range map[string]bool{
		"tasks_project_assigned_to_created_id":     true,
		"tasks_project_assigned_to_created_id_all": false,
	} {
		var definition string
		var hasPredicate bool
		if err := pool.QueryRow(ctx, `SELECT pg_get_indexdef(indexrelid), indpred IS NOT NULL
			FROM pg_index WHERE indexrelid=to_regclass($1) AND indrelid='tasks'::regclass AND indisvalid`, name).Scan(&definition, &hasPredicate); err != nil || hasPredicate != predicate || !strings.Contains(definition, "(project_id, assigned_to, created_at, id)") {
			t.Fatalf("index %s definition %q predicate %v: %v", name, definition, hasPredicate, err)
		}
	}
	var applied, repeated time.Time
	var after string
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=63`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT (SELECT applied_at FROM schema_migrations WHERE version=63),
		(SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t)`).Scan(&repeated, &after); err != nil || !applied.Equal(repeated) || before != after {
		t.Fatalf("migration changed task facts or repeated ledger: %v", err)
	}
}
