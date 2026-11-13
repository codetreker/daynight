package postgres

import (
	"context"
	"testing"
)

func TestProjectGitHubMigrationRollbackAndUpgradePreserveResources(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if len(schemaMigrations) < 68 || schemaMigrations[67].version != 68 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:67]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,description,status,version) VALUES($1,$2,'Existing task','original material','todo',9)`, queryID(10), project.ID)
	snapshot := func() string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),
			'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
			'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<=67))::text`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := snapshot()
	// An existing conflicting object makes the second CREATE fail after the
	// connection table and its indexes have been created in the transaction.
	mustQueryExec(t, db, `CREATE TABLE project_pull_requests (sentinel text)`)
	if err := migrate(ctx, pool, schemaMigrations); err == nil {
		t.Fatal("expected migration to fail on conflicting table")
	}
	var connectionExists bool
	var ledgerCount, sentinelColumns int
	if err := pool.QueryRow(ctx, `SELECT to_regclass('project_github') IS NOT NULL,
		(SELECT count(*) FROM schema_migrations WHERE version=68),
		(SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_pull_requests' AND column_name='sentinel')`).Scan(&connectionExists, &ledgerCount, &sentinelColumns); err != nil || connectionExists || ledgerCount != 0 || sentinelColumns != 1 {
		t.Fatalf("failed migration was not rolled back: connection=%v ledger=%d sentinel=%d err=%v", connectionExists, ledgerCount, sentinelColumns, err)
	}
	if after := snapshot(); after != before {
		t.Fatalf("failed migration changed existing resources: before=%s after=%s", before, after)
	}
	mustQueryExec(t, db, `DROP TABLE project_pull_requests`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(); after != before {
		t.Fatalf("upgrade changed existing resources: before=%s after=%s", before, after)
	}
	var checksum string
	if err := pool.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version=68`).Scan(&checksum); err != nil || checksum != schemaMigrations[67].checksum() {
		t.Fatalf("migration ledger mismatch: %q %v", checksum, err)
	}
	mustQueryExec(t, db, `INSERT INTO project_github(project_id) VALUES($1)`, project.ID)
	var version, generation, revision int64
	var enabled bool
	var interval int
	var access string
	var claimToken, claimKind *string
	if err := pool.QueryRow(ctx, `SELECT version,generation,revision,enabled,poll_interval_minutes,access_state,claim_token::text,claim_kind FROM project_github WHERE project_id=$1`, project.ID).Scan(&version, &generation, &revision, &enabled, &interval, &access, &claimToken, &claimKind); err != nil || version != 1 || generation != 0 || revision != 0 || enabled || interval != 5 || access != "unknown" || claimToken != nil || claimKind != nil {
		t.Fatalf("unconnected defaults: version=%d generation=%d revision=%d enabled=%v interval=%d access=%q token=%v kind=%v err=%v", version, generation, revision, enabled, interval, access, claimToken, claimKind, err)
	}
	for _, name := range []string{"project_github_binding", "project_github_poll_due", "project_github_access_due", "project_pull_requests_state_number"} {
		var valid bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=$1 AND i.indisvalid AND i.indisready)`, name).Scan(&valid); err != nil || !valid {
			t.Fatalf("missing index %s: %v", name, err)
		}
	}
}
