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
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 123 })
	if index < 1 || schemaMigrations[index-1].version != 122 {
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
 (SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<123))::text`).Scan(&facts); err != nil {
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
 AND (SELECT checksum=$3 FROM schema_migrations WHERE version=123)
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
 NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=123)
 AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='tasks'::regclass AND attname='ancestor_deleted_at' AND NOT attisdropped)`).Scan(&intact); err != nil || !intact {
		t.Fatalf("failed migration left column or ledger: intact=%v err=%v", intact, err)
	}
	if ancestorMigrationFacts(t, pool) != before || ancestorMigrationView(t, pool) != view {
		t.Fatal("failed migration changed stored resources or historical visibility")
	}
}

func TestTaskAncestorVisibilityMigrationRejectsInvalidHistoricalHierarchy(t *testing.T) {
	pool, _ := ancestorVisibilityMigrationFixture(t)
	facts, originalView := ancestorMigrationFacts(t, pool), ancestorMigrationView(t, pool)
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
		if !t.Run(scenario.name, func(t *testing.T) {
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
			if _, err := pool.Exec(t.Context(), `UPDATE tasks SET type='task', parent_id=CASE WHEN id=$1 THEN $3::uuid ELSE NULL END WHERE id IN ($1,$2)`, queryID(13), queryID(12), queryID(10)); err != nil {
				t.Fatal(err)
			}
			assertAncestorMigrationRolledBack(t, pool, facts, originalView)
		}) {
			return
		}
	}
}

func TestTaskAncestorVisibilityMigrationLedgerFailureRollsBackAndRecovers(t *testing.T) {
	pool, _ := ancestorVisibilityMigrationFixture(t)
	before, view := ancestorMigrationFacts(t, pool), ancestorMigrationView(t, pool)
	if _, err := pool.Exec(t.Context(), `CREATE FUNCTION reject_ancestor_visibility_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.version=123 THEN RAISE EXCEPTION 'injected ancestor visibility ledger failure'; END IF; RETURN NEW; END $$;
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
		taskExpr := `to_jsonb(t) - 'ancestor_deleted_at'`
		if typed {
			taskExpr += ` - 'type' - 'parent_id'`
		}
		dependencyExpr := `to_jsonb(d)`
		if typed {
			dependencyExpr += ` - 'dependency_type' - 'goal_edge_id'`
		}
		var result string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(`+taskExpr+` ORDER BY id) FROM tasks t), 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p), 'dependencies',(SELECT jsonb_agg(`+dependencyExpr+` ORDER BY task_id,depends_on_task_id) FROM task_dependencies d), 'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path) FROM task_attachments a))::text`).Scan(&result)
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

func TestDependencyTypesMigrationPreservesLegacyWrites(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 90 })
	if index < 0 {
		t.Fatal("dependency type migration missing")
	}
	old, current := schemaMigrations[:index], schemaMigrations[:index+1]
	if err := migrate(ctx, pool, old); err != nil {
		t.Fatal(err)
	}
	ledger := func() string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	indexes := func() string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, `SELECT string_agg(indexdef, E'\n' ORDER BY indexname) FROM pg_indexes WHERE schemaname=current_schema() AND tablename='task_dependencies'`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	oldLedger, oldIndexes := ledger(), indexes()
	project, first, second, third, fourth := queryID(1), queryID(2), queryID(3), queryID(4), queryID(5)
	if _, err := pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project, second, first); err != nil {
		t.Fatal(err)
	}

	// The old writer holds its transaction open while the migration requests the table lock.
	writer, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	if _, err := writer.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,false)`, project, third, first); err != nil {
		t.Fatal(err)
	}
	migrationPool, application := migrationInstance(t, pool)
	result := make(chan error, 1)
	go func() { result <- migrate(ctx, migrationPool, current) }()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid)
			WHERE a.application_name=$1 AND l.relation='task_dependencies'::regclass AND NOT l.granted)`, application).Scan(&waiting) == nil && waiting
	})
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}

	var priorLedger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version < 90`).Scan(&priorLedger); err != nil || priorLedger != oldLedger {
		t.Fatalf("prior migration ledger changed: before=%s after=%s err=%v", oldLedger, priorLedger, err)
	}
	if got := indexes(); got != oldIndexes {
		t.Fatalf("legacy indexes changed: before=%s after=%s", oldIndexes, got)
	}
	// The old INSERT still supplies only the original columns after migration.
	if _, err := pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project, fourth, first); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT task_id::text,depends_on_task_id::text,external,dependency_type,goal_edge_id::text FROM task_dependencies WHERE project_id=$1 ORDER BY task_id`, project)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for _, want := range []struct {
		id       string
		external bool
	}{{second, true}, {third, false}, {fourth, true}} {
		if !rows.Next() {
			t.Fatalf("missing legacy edge for %s: %v", want.id, rows.Err())
		}
		var id, predecessor, typ string
		var external bool
		var edgeID *string
		if err := rows.Scan(&id, &predecessor, &external, &typ, &edgeID); err != nil {
			t.Fatal(err)
		}
		if id != want.id || predecessor != first || external != want.external || typ != "task" || edgeID != nil {
			t.Fatalf("unexpected edge: %s %s external=%v type=%s edgeID=%v", id, predecessor, external, typ, edgeID)
		}
	}
	if rows.Next() || rows.Err() != nil {
		t.Fatalf("unexpected extra edge or read error: %v", rows.Err())
	}
	rows.Close()

	newLedger := ledger()
	if err := migrate(ctx, pool, old); err == nil || !strings.Contains(err.Error(), "not an ordered prefix") {
		t.Fatalf("old migration prefix accepted new ledger: %v", err)
	}
	if err := migrate(ctx, pool, current); err != nil {
		t.Fatalf("repeated migration: %v", err)
	}
	if got := ledger(); got != newLedger {
		t.Fatalf("rejection or repeated migration changed ledger: before=%s after=%s", newLedger, got)
	}
	assertMigrationPoolReusable(t, migrationPool)
}

func TestGoalDependencyMigrationFailurePreservesFirstStageAndResumes(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 91 })
	if index < 1 || schemaMigrations[index-1].version != 90 {
		t.Fatal("goal dependency migrations are not consecutive")
	}
	first, both := schemaMigrations[:index], schemaMigrations[:index+1]
	if err := migrate(ctx, pool, first); err != nil {
		t.Fatal(err)
	}
	project, source, target := queryID(1), queryID(2), queryID(3)
	if _, err := pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project, source, target); err != nil {
		t.Fatal(err)
	}
	ledger := func() string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	prior := ledger()
	bad := append([]migration(nil), both...)
	bad[index].sql += `; SELECT 1 / 0`
	var failure *pgconn.PgError
	if err := migrate(ctx, pool, bad); !errors.As(err, &failure) || failure.Code != "22012" {
		t.Fatalf("injected second migration failure: %v", err)
	}
	var relation, reverse, identity *string
	var typ string
	var edgeID *string
	err := pool.QueryRow(ctx, `SELECT to_regclass('goal_dependency_revisions')::text,to_regclass('goal_dependencies_predecessor')::text,to_regclass('goal_dependencies_edge_id')::text,dependency_type,goal_edge_id::text FROM task_dependencies WHERE project_id=$1 AND task_id=$2`, project, source).Scan(&relation, &reverse, &identity, &typ, &edgeID)
	if err != nil || relation != nil || reverse != nil || identity != nil || typ != "task" || edgeID != nil || ledger() != prior {
		t.Fatalf("partial second migration or lost first: table=%v reverse=%v id=%v type=%s edge=%v err=%v", relation, reverse, identity, typ, edgeID, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project, queryID(4), target); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, both); err != nil {
		t.Fatalf("resume actual migration: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_dependencies WHERE dependency_type='task' AND goal_edge_id IS NULL`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("old writes lost: count=%d err=%v", count, err)
	}
	if err := migrate(ctx, pool, first); err == nil || !strings.Contains(err.Error(), "not an ordered prefix") {
		t.Fatalf("old prefix accepted new ledger: %v", err)
	}
	var oldLedger string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m WHERE version<=90`).Scan(&oldLedger); err != nil || oldLedger != prior {
		t.Fatalf("resume changed first-stage ledger: %v", err)
	}
	assertMigrationPoolReusable(t, pool)
}
