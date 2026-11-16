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
