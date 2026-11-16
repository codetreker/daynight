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
	if err := migrate(ctx, pool, schemaMigrations[:68]); err == nil {
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
	if err := migrate(ctx, pool, schemaMigrations[:68]); err != nil {
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

func TestProjectGitHubPendingMigrationRollbackAndUpgrade(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if len(schemaMigrations) < 69 || schemaMigrations[68].version != 69 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:68]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled) VALUES($1,3,2,7,true)`, project.ID)
	mustQueryExec(t, db, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision) VALUES($1,5,50,'url','title','open',false,'main','sha',now(),now(),'body',now(),7)`, project.ID)
	snapshot := func() string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
			'connections',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id) FROM project_github g),
			'pull_requests',(SELECT jsonb_agg(to_jsonb(p) ORDER BY project_id,number) FROM project_pull_requests p),
			'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m WHERE version<=68))::text`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := snapshot()
	// The conflicting index aborts after CREATE TABLE, exercising transactional DDL.
	mustQueryExec(t, db, `CREATE INDEX project_github_pending_prs_due ON project_github (project_id)`)
	if err := migrate(ctx, pool, schemaMigrations[:69]); err == nil {
		t.Fatal("expected migration to fail on conflicting index")
	}
	var exists bool
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT to_regclass('project_github_pending_prs') IS NOT NULL, (SELECT count(*) FROM schema_migrations WHERE version=69)`).Scan(&exists, &ledger); err != nil || exists || ledger != 0 {
		t.Fatalf("failed migration was not rolled back: table=%v ledger=%d err=%v", exists, ledger, err)
	}
	if after := snapshot(); after != before {
		t.Fatalf("failed migration changed B1 resources: before=%s after=%s", before, after)
	}
	mustQueryExec(t, db, `DROP INDEX project_github_pending_prs_due`)
	if err := migrate(ctx, pool, schemaMigrations[:69]); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(); after != before {
		t.Fatalf("upgrade changed B1 resources: before=%s after=%s", before, after)
	}
	var checksum string
	var valid bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT checksum FROM schema_migrations WHERE version=69), EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname='project_github_pending_prs_due' AND i.indisvalid AND i.indisready)`).Scan(&checksum, &valid); err != nil || checksum != schemaMigrations[68].checksum() || !valid {
		t.Fatalf("migration ledger or due index: checksum=%q valid=%v err=%v", checksum, valid, err)
	}
	mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,2,$2,'delivery',now(),now())`, project.ID, queryID(11))
	if _, err := pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,2,$2,'duplicate',now(),now())`, project.ID, queryID(12)); err == nil {
		t.Fatal("duplicate project and PR number was accepted")
	}
}

func TestProjectGitHubSyncMigrationStopsExistingWorkAndPreservesFacts(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if len(schemaMigrations) < 73 || schemaMigrations[72].version != 73 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:72]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	missing := projectBeforeSettings(t, db, 2)
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled,app_id,installation_id,repository_id,access_state,not_before,last_full_success_at,poll_error_code,next_poll_at,next_access_check_at,claim_token,claim_until,claim_kind,access_hint_id,access_delivery_id) VALUES($1,3,2,7,true,10,20,30,'available','2030-01-01','2020-01-01','retained',now(),now(),$2,now(),'poll',$3,'delivery')`, project.ID, queryID(11), queryID(12))
	mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,2,$2,'delivery',now(),now())`, project.ID, queryID(13))
	mustQueryExec(t, db, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision) VALUES($1,5,50,'url','title','open',false,'main','sha',now(),now(),'body',now(),7)`, project.ID)
	mustQueryExec(t, db, `UPDATE project_github SET revision=9223372036854775807 WHERE project_id=$1`, project.ID)
	if err := migrate(ctx, pool, schemaMigrations[:73]); err == nil {
		t.Fatal("overflow must fail the migration")
	}
	var columnExists bool
	var pending int
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_github' AND column_name='sync_enabled'), (SELECT count(*) FROM project_github_pending_prs)`).Scan(&columnExists, &pending); err != nil || columnExists || pending != 1 {
		t.Fatalf("failed migration must roll back: column=%v pending=%d err=%v", columnExists, pending, err)
	}
	mustQueryExec(t, db, `UPDATE project_github SET revision=7 WHERE project_id=$1`, project.ID)
	if err := migrate(ctx, pool, schemaMigrations[:73]); err != nil {
		t.Fatal(err)
	}
	var preserved, cleared bool
	if err := pool.QueryRow(ctx, `SELECT version=4 AND generation=3 AND revision=8 AND enabled AND NOT sync_enabled AND app_id=10 AND installation_id=20 AND repository_id=30 AND access_state='available' AND not_before='2030-01-01'::timestamptz AND last_full_success_at='2020-01-01'::timestamptz AND poll_error_code='retained', next_poll_at IS NULL AND next_access_check_at IS NULL AND claim_token IS NULL AND claim_until IS NULL AND claim_kind IS NULL AND access_hint_id IS NULL AND access_delivery_id IS NULL FROM project_github WHERE project_id=$1`, project.ID).Scan(&preserved, &cleared); err != nil || !preserved || !cleared {
		t.Fatalf("upgraded facts: preserved=%t cleared=%t err=%v", preserved, cleared, err)
	}
	var prs, connections int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_github_pending_prs), (SELECT count(*) FROM project_pull_requests WHERE project_id=$1 AND description='body'), (SELECT count(*) FROM project_github WHERE project_id=$2)`, project.ID, missing.ID).Scan(&pending, &prs, &connections); err != nil || pending != 0 || prs != 1 || connections != 0 {
		t.Fatalf("retained data: pending=%d prs=%d missing connections=%d err=%v", pending, prs, connections, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE project_github SET enabled=false,sync_enabled=true WHERE project_id=$1`, project.ID); err == nil {
		t.Fatal("sync without connection must violate constraint")
	}
}
