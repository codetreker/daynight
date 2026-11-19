package postgres

import (
	"slices"
	"testing"
)

func TestReviewAssignmentMigrationRollbackAndUpgrade(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	idx := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 96 })
	if idx < 0 {
		t.Fatal("migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:idx]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	mustQueryExec(t, db, `CREATE INDEX workers_review_participants ON workers(user_id)`)
	if err := migrate(ctx, pool, schemaMigrations[:idx+1]); err == nil {
		t.Fatal("conflicting index must fail")
	}
	var table bool
	var count int
	if err := pool.QueryRow(ctx, `SELECT to_regclass('project_pr_review_assignments') IS NOT NULL,(SELECT count(*) FROM schema_migrations WHERE version=96)`).Scan(&table, &count); err != nil || table || count != 0 {
		t.Fatalf("rollback: table %v ledger %d: %v", table, count, err)
	}
	mustQueryExec(t, db, `DROP INDEX workers_review_participants`)
	if err := migrate(ctx, pool, schemaMigrations[:idx+1]); err != nil {
		t.Fatal(err)
	}
	var valid bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname='workers_review_participants' AND i.indisvalid AND i.indisready)`).Scan(&valid); err != nil || !valid {
		t.Fatalf("index %v %v", valid, err)
	}
}
