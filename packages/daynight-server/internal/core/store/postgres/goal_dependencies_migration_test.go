package postgres

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

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
