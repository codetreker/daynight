package postgres

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func ancestorVisibilityMigrationFixture(t *testing.T) (*pgxpool.Pool, int) {
	t.Helper()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 122 })
	if index < 1 || schemaMigrations[index-1].version != 121 {
		t.Fatal("ancestor visibility migration must follow the actual previous ledger")
	}
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	first, second := projectBeforeSettings(t, db, 1), projectBeforeSettings(t, db, 2)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,parent_id,title,status,version,created_at,updated_at,deleted_at) VALUES
 ($1,$8,'goal',NULL,'Open Goal','todo',3,'2026-01-01','2026-01-02',NULL),
 ($2,$8,'goal',NULL,'Deleted Goal','done',9,'2026-01-01','2026-01-03','2026-01-03'),
 ($3,$8,'task',NULL,'Root task','todo',5,'2026-01-01','2026-01-02',NULL),
 ($4,$8,'task',$1,'Visible child','todo',7,'2026-01-01','2026-01-02',NULL),
 ($5,$8,'task',$2,'Inherited hidden child','done',9007199254740993,'2026-01-01','2026-01-02',NULL),
 ($6,$8,'task',$2,'Physically deleted child','done',11,'2026-01-01','2026-01-02','2026-01-02'),
 ($7,$9,'goal',NULL,'Other project Goal','todo',13,'2026-01-01','2026-01-02',NULL)`,
		queryID(10), queryID(11), queryID(12), queryID(13), queryID(14), queryID(15), queryID(16), first.ID, second.ID)
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'retained','{"proof":true}')`, queryID(14))
	mustQueryExec(t, db, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($2,$1,'proof.txt','text/plain',7)`, queryID(14), first.ID)
	mustQueryExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($2,$1,$3,false)`, queryID(14), first.ID, queryID(12))
	return pool, index
}

func ancestorMigrationFacts(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var facts string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(t)-'ancestor_deleted_at' ORDER BY id) FROM tasks t),
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p),
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path) FROM task_attachments a),
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY task_id,depends_on_task_id) FROM task_dependencies d),
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<122))::text`).Scan(&facts); err != nil {
		t.Fatal(err)
	}
	return facts
}

func ancestorMigrationView(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var view string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_array(
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM task_resource_rows r),
 (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnum) ORDER BY attnum)
    FROM pg_attribute WHERE attrelid='task_resource_rows'::regclass AND attnum>0 AND NOT attisdropped))::text`).Scan(&view); err != nil {
		t.Fatal(err)
	}
	return view
}

func TestTaskAncestorVisibilityMigrationPreservesHistoricalResources(t *testing.T) {
	pool, index := ancestorVisibilityMigrationFixture(t)
	before, view := ancestorMigrationFacts(t, pool), ancestorMigrationView(t, pool)
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := ancestorMigrationFacts(t, pool); after != before {
		t.Fatalf("migration changed business fields, relations, resources, epoch or previous ledger: before=%s after=%s", before, after)
	}
	if after := ancestorMigrationView(t, pool); after != view {
		t.Fatalf("migration changed historical visibility or view column identity: before=%s after=%s", view, after)
	}
	var valid bool
	if err := pool.QueryRow(t.Context(), `SELECT
 (SELECT count(*)=1 FROM tasks WHERE ancestor_deleted_at IS NOT NULL)
 AND (SELECT ancestor_deleted_at='2026-01-03'::timestamptz AND deleted_at IS NULL FROM tasks WHERE id=$1)
 AND (SELECT ancestor_deleted_at IS NULL AND deleted_at='2026-01-02'::timestamptz FROM tasks WHERE id=$2)
 AND (SELECT checksum=$3 FROM schema_migrations WHERE version=122)
 AND to_regclass('tasks_project_parent_created_id') IS NOT NULL`, queryID(14), queryID(15), schemaMigrations[index].checksum()).Scan(&valid); err != nil || !valid {
		t.Fatalf("backfill, physical tombstone, checksum or existing index: valid=%v err=%v", valid, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE tasks SET ancestor_deleted_at='2026-01-03' WHERE id=$1`, queryID(15)); err != nil {
		t.Fatal(err)
	}
	var physical bool
	if err := pool.QueryRow(t.Context(), `SELECT effective_deleted_at='2026-01-02'::timestamptz FROM task_resource_rows WHERE id=$1`, queryID(15)).Scan(&physical); err != nil || !physical {
		t.Fatalf("physical tombstone must take precedence: %v", err)
	}
	after := ancestorMigrationFacts(t, pool)
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil || ancestorMigrationFacts(t, pool) != after {
		t.Fatalf("repeat migration changed resources: %v", err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations[:index]); err == nil {
		t.Fatal("old ledger accepted the migrated database")
	}
}

func assertAncestorMigrationRolledBack(t *testing.T, pool *pgxpool.Pool, before, view string) {
	t.Helper()
	var intact bool
	if err := pool.QueryRow(t.Context(), `SELECT
 NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=122)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='tasks'::regclass AND attname='ancestor_deleted_at' AND NOT attisdropped)`).Scan(&intact); err != nil || !intact {
		t.Fatalf("failed migration left column or ledger: intact=%v err=%v", intact, err)
	}
	if ancestorMigrationFacts(t, pool) != before || ancestorMigrationView(t, pool) != view {
		t.Fatal("failed migration changed stored resources or historical visibility")
	}
}

func TestTaskAncestorVisibilityMigrationRejectsInvalidHistoricalHierarchy(t *testing.T) {
	for _, scenario := range []struct {
		name, mutation, reason string
		args                   []any
	}{
		{"type", `UPDATE tasks SET type='invalid' WHERE id=$1`, "invalid task type", []any{queryID(13)}},
		{"Goal parent", `UPDATE tasks SET type='goal',parent_id=$2 WHERE id=$1`, "Goal has a parent", []any{queryID(13), queryID(10)}},
		{"missing parent", `UPDATE tasks SET parent_id='00000000-0000-4000-8000-000000999999' WHERE id=$1`, "parent does not exist", []any{queryID(13)}},
		{"cross project", `UPDATE tasks SET parent_id=$2 WHERE id=$1`, "parent belongs to another project", []any{queryID(13), queryID(16)}},
		{"ordinary parent", `UPDATE tasks SET parent_id=$2 WHERE id=$1`, "parent is not a Goal", []any{queryID(13), queryID(12)}},
		{"deep Goal", `UPDATE tasks SET type=CASE WHEN id=$1 THEN 'goal' ELSE type END,parent_id=CASE WHEN id=$1 THEN $3::uuid ELSE $1::uuid END WHERE id IN ($1,$2)`, "Goal has a parent", []any{queryID(12), queryID(13), queryID(10)}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			pool, _ := ancestorVisibilityMigrationFixture(t)
			if _, err := pool.Exec(t.Context(), scenario.mutation, scenario.args...); err != nil {
				t.Fatal(err)
			}
			before, view := ancestorMigrationFacts(t, pool), ancestorMigrationView(t, pool)
			err := migrate(t.Context(), pool, schemaMigrations)
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != "DN120" || !strings.Contains(failure.Message, scenario.reason) || !strings.Contains(failure.Detail, "task=") || !strings.Contains(failure.Detail, "project=") || !strings.Contains(failure.Detail, "parent=") {
				t.Fatalf("historical hierarchy failure lost diagnostic identity: %v", err)
			}
			assertAncestorMigrationRolledBack(t, pool, before, view)
			opened, err := Open(t.Context(), pool.Config().ConnString())
			if opened != nil {
				opened.Close()
				t.Fatal("startup accepted invalid historical hierarchy")
			}
			var diagnostic *store.Error
			if !errors.As(err, &diagnostic) || diagnostic.SQLState != "DN120" || !strings.Contains(diagnostic.Phase, failure.Detail) || !strings.Contains(diagnostic.Phase, scenario.reason) {
				t.Fatalf("startup discarded locatable hierarchy diagnostic: %v", err)
			}
			assertAncestorMigrationRolledBack(t, pool, before, view)
		})
	}
}

func TestTaskAncestorVisibilityMigrationLedgerFailureRollsBackAndRecovers(t *testing.T) {
	pool, _ := ancestorVisibilityMigrationFixture(t)
	before, view := ancestorMigrationFacts(t, pool), ancestorMigrationView(t, pool)
	if _, err := pool.Exec(t.Context(), `CREATE FUNCTION reject_ancestor_visibility_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.version=122 THEN RAISE EXCEPTION 'injected ancestor visibility ledger failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER reject_ancestor_visibility_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_ancestor_visibility_ledger()`); err != nil {
		t.Fatal(err)
	}
	err := migrate(t.Context(), pool, schemaMigrations)
	var failure *pgconn.PgError
	if !errors.As(err, &failure) || !strings.Contains(failure.Message, "injected ancestor visibility ledger failure") {
		t.Fatalf("migration lost injected ledger failure: %v", err)
	}
	assertAncestorMigrationRolledBack(t, pool, before, view)
	if _, err := pool.Exec(t.Context(), `DROP TRIGGER reject_ancestor_visibility_ledger ON schema_migrations; DROP FUNCTION reject_ancestor_visibility_ledger()`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatalf("migration failed after repairing the cause: %v", err)
	}
}

func TestTaskAncestorVisibilityMigrationLockWaitCancellation(t *testing.T) {
	pool, _ := ancestorVisibilityMigrationFixture(t)
	before, view := ancestorMigrationFacts(t, pool), ancestorMigrationView(t, pool)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `LOCK TABLE tasks IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	instance, application := migrationInstance(t, pool)
	migrationCtx, stop := context.WithCancel(ctx)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- migrate(migrationCtx, instance, schemaMigrations) }()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a USING(pid)
 WHERE l.relation='tasks'::regclass AND l.mode='AccessExclusiveLock' AND NOT l.granted AND a.application_name=$1)`, application).Scan(&waiting) == nil && waiting
	})
	stop()
	if err := <-done; err == nil || !(errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "context canceled")) {
		t.Fatalf("migration did not preserve lock-wait cancellation: %v", err)
	}
	assertAncestorMigrationRolledBack(t, pool, before, view)
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("migration did not recover after the lock was released: %v", err)
	}
	assertMigrationPoolReusable(t, instance)
}
