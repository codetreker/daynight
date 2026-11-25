package postgres

import (
	"strings"
	"testing"
)

func TestTeamNestedSubtasksMigrationDefaultsAndLedger(t *testing.T) {
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	migrateTo(t, pool, 129)
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'existing')`, queryID(1)); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'new')`, queryID(2)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM teams WHERE id IN ($1,$2) AND allow_nested_subtask=false`, queryID(1), queryID(2)).Scan(&count); err != nil || count != 2 {
		t.Fatalf("defaults: count=%d err=%v", count, err)
	}
	if err := migrate(ctx, pool, migrationsThrough(129)); err == nil || !strings.Contains(err.Error(), "not an ordered prefix") {
		t.Fatalf("old registry accepted newer ledger: %v", err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}
