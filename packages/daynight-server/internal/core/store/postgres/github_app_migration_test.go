package postgres

import (
	"testing"
)

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
