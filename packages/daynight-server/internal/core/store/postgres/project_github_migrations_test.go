package postgres

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
	mustQueryExec(t, db, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,author_id,author_login,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision) VALUES($1,5,50,'url','title',9007199254740997,'author','open',false,'main','sha',now(),now(),'body',now(),7)`, project.ID)
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
	if err := migrate(ctx, pool, schemaMigrations[:77]); err != nil {
		t.Fatal(err)
	}
	var beforePR, afterPR string
	const readPR = `SELECT to_jsonb(p)::text FROM project_pull_requests p WHERE project_id=$1 AND number=5`
	if err := pool.QueryRow(ctx, readPR, project.ID).Scan(&beforePR); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:78]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, readPR, project.ID).Scan(&afterPR); err != nil || afterPR != beforePR {
		t.Fatalf("PR author index migration changed historical PR: before=%s after=%s err=%v", beforePR, afterPR, err)
	}
	var valid bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT FROM pg_index WHERE indexrelid=to_regclass('project_pull_requests_author_number') AND indisvalid AND indisready)`).Scan(&valid); err != nil || !valid {
		t.Fatalf("historical PR author index not usable: valid=%t err=%v", valid, err)
	}
}

func TestGitHubAppMigrationPreservesExistingConnections(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if len(schemaMigrations) < 76 || schemaMigrations[75].version != 76 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:75]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := projectBeforeSettings(t, db, 1)
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,claim_token,claim_until,claim_kind,access_hint_id,access_delivery_id) VALUES ($1,7,8,9,true,true,10,20,30,$2,now(),'poll',$3,'delivery')`, project.ID, queryID(11), queryID(12))
	mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES ($1,5,8,$2,'delivery',now(),now())`, project.ID, queryID(13))
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(g)::text FROM project_github g WHERE project_id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:76]); err != nil {
		t.Fatal(err)
	}
	var after string
	var pending int
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(g)-'app_resource_id'-'team_grant_id'-'credential_version')::text, (SELECT count(*) FROM project_github_pending_prs) FROM project_github g WHERE project_id=$1`, project.ID).Scan(&after, &pending); err != nil || after != before || pending != 1 {
		t.Fatalf("upgrade changed prior rows: %s %s pending=%d err=%v", before, after, pending, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE project_github SET enabled=false WHERE project_id=$1`, project.ID); err != nil {
		t.Fatalf("retained sync intent after disconnect: %v", err)
	}
	for _, name := range []string{"github_apps_live_github_app_id", "github_app_admins_user", "github_app_admin_invitations_app", "github_app_team_grants_live", "github_app_team_grants_team", "project_github_app_resource", "project_github_team_grant"} {
		var valid bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=$1 AND i.indisvalid AND i.indisready)`, name).Scan(&valid); err != nil || !valid {
			t.Fatalf("index %s: %v", name, err)
		}
	}
}

func TestGitHubAppCutoverPreservesIntentAndHistory(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if len(schemaMigrations) < 77 || schemaMigrations[76].version != 77 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:76]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	connected := projectBeforeSettings(t, db, 1)
	unconnected := projectBeforeSettings(t, db, 2)
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,installation_account_login,repository_full_name,repository_private,access_state,access_reason,access_checked_at,next_access_check_at,next_poll_at,not_before,claim_token,claim_until,claim_kind,access_hint_id,access_delivery_id,last_full_success_at,poll_error_code) VALUES($1,7,8,9,true,true,10,20,30,'owner','owner/repo',true,'available','ok',now(),now(),now(),now(),$2,now(),'poll',$3,'delivery','2020-01-01','retained')`, connected.ID, queryID(11), queryID(12))
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled) VALUES($1,2,3,4,false,false)`, unconnected.ID)
	mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,8,$2,'delivery',now(),now())`, connected.ID, queryID(13))
	mustQueryExec(t, db, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision) VALUES($1,5,50,'url','title','open',false,'main','sha',now(),now(),'body',now(),9)`, connected.ID)

	mustQueryExec(t, db, `UPDATE project_github SET revision=9223372036854775807 WHERE project_id=$1`, connected.ID)
	if err := migrate(ctx, pool, schemaMigrations[:77]); err == nil {
		t.Fatal("overflow must fail the migration")
	}
	var unchanged bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT enabled AND sync_enabled AND app_id=10 AND claim_token IS NOT NULL AND revision=9223372036854775807 FROM project_github WHERE project_id=$1) AND (SELECT version=2 AND generation=3 AND revision=4 FROM project_github WHERE project_id=$2) AND (SELECT count(*)=1 FROM project_github_pending_prs) AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version=77)`, connected.ID, unconnected.ID).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("failed cutover changed data or ledger: unchanged=%t err=%v", unchanged, err)
	}
	mustQueryExec(t, db, `UPDATE project_github SET revision=9 WHERE project_id=$1`, connected.ID)
	if err := migrate(ctx, pool, schemaMigrations[:77]); err != nil {
		t.Fatal(err)
	}
	var cleared, preserved, other bool
	if err := pool.QueryRow(ctx, `SELECT NOT enabled AND sync_enabled AND app_id IS NULL AND installation_id IS NULL AND app_resource_id IS NULL AND team_grant_id IS NULL AND credential_version IS NULL AND installation_account_login IS NULL AND access_state='unknown' AND access_reason IS NULL AND access_checked_at IS NULL AND next_access_check_at IS NULL AND next_poll_at IS NULL AND not_before IS NULL AND claim_token IS NULL AND claim_until IS NULL AND claim_kind IS NULL AND access_hint_id IS NULL AND access_delivery_id IS NULL, version=8 AND generation=9 AND revision=10 AND repository_id=30 AND repository_full_name='owner/repo' AND repository_private AND last_full_success_at='2020-01-01'::timestamptz AND poll_error_code='retained' AND EXISTS(SELECT 1 FROM project_pull_requests WHERE project_id=$1 AND description='body') AND NOT EXISTS(SELECT 1 FROM project_github_pending_prs), (SELECT NOT enabled AND NOT sync_enabled AND version=3 AND generation=4 AND revision=5 FROM project_github WHERE project_id=$2) FROM project_github WHERE project_id=$1`, connected.ID, unconnected.ID).Scan(&cleared, &preserved, &other); err != nil || !cleared || !preserved || !other {
		t.Fatalf("cutover: cleared=%t preserved=%t other=%t err=%v", cleared, preserved, other, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:77]); err != nil {
		t.Fatal(err)
	}
	var checksum string
	if err := pool.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version=77 AND (SELECT version=8 AND generation=9 AND revision=10 FROM project_github WHERE project_id=$1)`, connected.ID).Scan(&checksum); err != nil || checksum != schemaMigrations[76].checksum() {
		t.Fatalf("replay or ledger: checksum=%q err=%v", checksum, err)
	}
}

func TestGitHubCoverageMigrationRetainsWorkAndInitializesIntent(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 88 })
	if index < 1 || schemaMigrations[index].version != 88 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	active, unavailable, disabled := queryID(101), queryID(102), queryID(103)
	_, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,repository_id,access_state,not_before,last_full_success_at,last_full_generation,poll_error_code,claim_token,claim_until,claim_kind)
        VALUES($1,3,7,9,true,true,22,'available','2030-01-01','2020-01-01',7,'retained',$4,'2030-01-01','poll'),
        ($2,3,7,9,true,true,22,'unavailable','2030-01-01','2020-01-01',7,'retained',NULL,NULL,NULL),
        ($3,3,7,9,true,false,22,'available',NULL,'2020-01-01',7,NULL,NULL,NULL,NULL)`, active, unavailable, disabled, queryID(104))
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,7,$2,'delivery',now(),now())`, active, queryID(105))
	if err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var count int
	var sameBoundary bool
	err = pool.QueryRow(ctx, `SELECT count(*), min(started_at)=max(started_at) AND min(started_at)=date_trunc('second',min(started_at)) FROM project_github_coverage`).Scan(&count, &sameBoundary)
	if err != nil || count != 2 || !sameBoundary {
		t.Fatalf("coverage count %d common boundary %v err %v", count, sameBoundary, err)
	}
	var preserved bool
	err = pool.QueryRow(ctx, `SELECT version=3 AND generation=7 AND revision=10 AND last_full_generation IS NULL AND last_full_success_at='2020-01-01'::timestamptz AND not_before='2030-01-01'::timestamptz AND poll_error_code='retained' AND claim_token=$2 AND next_poll_at IS NOT NULL AND EXISTS (SELECT 1 FROM project_github_pending_prs WHERE project_id=$1 AND request_id=$3) FROM project_github WHERE project_id=$1`, active, queryID(104), queryID(105)).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("preserved work %v err %v", preserved, err)
	}
	err = pool.QueryRow(ctx, `SELECT revision=10 AND last_full_generation IS NULL AND next_poll_at IS NULL FROM project_github WHERE project_id=$1`, unavailable).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("unavailable %v err %v", preserved, err)
	}
	err = pool.QueryRow(ctx, `SELECT revision=9 AND last_full_generation=7 AND NOT EXISTS(SELECT 1 FROM project_github_coverage WHERE project_id=$1) FROM project_github WHERE project_id=$1`, disabled).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("disabled %v err %v", preserved, err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err = pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,22,$2)`, active, now.Add(time.Hour)); err == nil {
		t.Fatal("second open period accepted")
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at,ended_at) VALUES($1,99,$2,$2)`, disabled, now); err == nil {
		t.Fatal("empty period accepted")
	}
}

func TestGitHubRepositorySourcesMigration(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 93 })
	if index < 1 || schemaMigrations[index-1].version != 92 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project, unconnected, invalid, connectedEmpty := queryID(301), queryID(302), queryID(303), queryID(304)
	_, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,repository_id,repository_full_name,version,revision)
	 VALUES($1,123,'owner/original',4,8),($2,NULL,NULL,1,0),($3,789,'empty/repo',1,0)`, project, unconnected, connectedEmpty)
	if err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,description,observed_at,revision)
	 VALUES($1,7,70,'url','original','open',false,'main','sha','2020-01-01','2020-01-02','body','2020-01-03',8)`
	if _, err = pool.Exec(ctx, insert, project); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, insert, invalid); err != nil {
		t.Fatal(err)
	}
	for _, identity := range []struct {
		name string
		id   any
		full any
	}{
		{"missing connection", nil, nil},
		{"missing id", nil, "owner/name"},
		{"zero id", 0, "owner/name"},
		{"negative id", -1, "owner/name"},
		{"missing name", 42, nil},
		{"empty name", 42, ""},
		{"malformed name", 42, "owner/name/extra"},
		{"dot segment", 42, "../name"},
	} {
		t.Run(identity.name, func(t *testing.T) {
			if identity.name != "missing connection" {
				if _, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,repository_id,repository_full_name)
				 VALUES($1,$2,$3) ON CONFLICT(project_id) DO UPDATE SET repository_id=EXCLUDED.repository_id,repository_full_name=EXCLUDED.repository_full_name`, invalid, identity.id, identity.full); err != nil {
					t.Fatal(err)
				}
			}
			err := migrate(ctx, pool, schemaMigrations[:index+1])
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != "DN093" || pgErr.Detail != invalid {
				t.Fatalf("expected identified rejection, got %v", err)
			}
			var title string
			var ledger int
			var changed bool
			err = pool.QueryRow(ctx, `SELECT title,(SELECT count(*) FROM schema_migrations WHERE version=93),
				 to_regclass('project_github_repositories') IS NOT NULL OR EXISTS
				 (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='project_pull_requests' AND column_name='repository_id')
				 FROM project_pull_requests WHERE project_id=$1 AND number=7`, project).Scan(&title, &ledger, &changed)
			if err != nil || title != "original" || ledger != 0 || changed {
				t.Fatalf("rollback: title=%q ledger=%d changed=%v err=%v", title, ledger, changed, err)
			}
		})
	}
	if _, err = pool.Exec(ctx, `UPDATE project_github SET repository_id=456,repository_full_name='other/repo' WHERE project_id=$1`, invalid); err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var preserved bool
	err = pool.QueryRow(ctx, `SELECT p.repository_id=123 AND p.number=7 AND p.github_id=70 AND p.title='original' AND p.description='body'
	 AND p.github_created_at='2020-01-01'::timestamptz AND p.github_updated_at='2020-01-02'::timestamptz AND p.observed_at='2020-01-03'::timestamptz AND p.revision=8
	 AND g.legacy_repository_id=123 AND g.version=4 AND g.revision=8 AND r.full_name='owner/original'
	 FROM project_pull_requests p JOIN project_github g ON g.project_id=p.project_id
	 JOIN project_github_repositories r ON r.project_id=p.project_id AND r.repository_id=p.repository_id
	 WHERE p.project_id=$1`, project).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("backfill preserved=%v err=%v", preserved, err)
	}
	var count int
	err = pool.QueryRow(ctx, `SELECT count(*) FROM project_github_repositories WHERE project_id=$1`, unconnected).Scan(&count)
	if err != nil || count != 0 {
		t.Fatalf("unconnected source count=%d err=%v", count, err)
	}
	err = pool.QueryRow(ctx, `SELECT count(*) FROM project_github g JOIN project_github_repositories r
	 ON r.project_id=g.project_id AND r.repository_id=g.legacy_repository_id
	 WHERE g.project_id=$1 AND r.repository_id=789 AND r.full_name='empty/repo'`, connectedEmpty).Scan(&count)
	if err != nil || count != 1 {
		t.Fatalf("connected source without PRs count=%d err=%v", count, err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision)
	 VALUES($1,456,7,71,'other','other','open',false,'main','sha',now(),now(),now(),1)`, project)
	if err != nil {
		t.Fatalf("same number from another source: %v", err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_pull_requests SELECT * FROM project_pull_requests WHERE project_id=$1 AND repository_id=123`, project); err == nil {
		t.Fatal("duplicate source and number accepted")
	}
	for _, name := range []string{"project_pull_requests_pkey", "project_pull_requests_state_number", "project_pull_requests_author_number"} {
		var definition string
		err := pool.QueryRow(ctx, `SELECT pg_get_indexdef(c.oid) FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid
		 WHERE c.relnamespace=current_schema()::regnamespace AND c.relname=$1 AND i.indisvalid AND i.indisready`, name).Scan(&definition)
		if err != nil || !strings.Contains(definition, "(project_id, repository_id,") {
			t.Fatalf("index %s: %q, %v", name, definition, err)
		}
	}
}

func TestGitHubRepositorySourcesOpenReportsProject(t *testing.T) {
	ctx := t.Context()
	url := scopedDatabaseURL(t)
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 93 })
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project := queryID(305)
	_, err = pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Open(ctx, url)
	if err == nil || !strings.Contains(err.Error(), project) {
		t.Fatalf("startup diagnostic: %v", err)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE project_id=$1`, project).Scan(&count); err != nil || count != 1 {
		t.Fatalf("old table: %d %v", count, err)
	}
}

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
	if _, err := pool.Exec(ctx, `INSERT INTO project_pr_review_assignments(user_id,project_id,repository_id,github_pr_id,worker_id,assigned_at)
		VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',3,4,'00000000-0000-4000-8000-000000000005',now())`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_pr_review_assignments WHERE repository_id=3 AND github_pr_id=4`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("later poll index migration changed assignments: rows=%d err=%v", rows, err)
	}
}
