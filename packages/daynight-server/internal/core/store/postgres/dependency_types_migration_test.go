package postgres

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
)

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
