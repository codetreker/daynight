package github_test

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
)

func TestGrantLifecycleAndAtomicStop(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, teamID, grant, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{UserID: actor, CredentialID: uuid.NewString(), Kind: model.SessionCredential}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'Team')`, []any{teamID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, actor}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','Remote','remote','key','secret')`, []any{app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, actor}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	create := func(id string) (store.Completion, error) {
		return db.WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error {
			_, err := core.CreateGrant(ctx, w, p, core.CreateGrantInput{ID: id, TeamID: teamID, ExpectedUserID: actor, Version: 1, TeamVersion: 1})
			return err
		})
	}
	if c, err := create(grant); err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("create: %+v %v", c, err)
	}
	if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error {
		preview, err := core.PreviewGrant(ctx, r, p, app, teamID)
		if err != nil || preview.Grant == nil || preview.Grant.ID != grant {
			return errors.New("preview missing grant")
		}
		apps, err := core.ListTeamApps(ctx, r, p, teamID, model.PageRequest{Limit: 1})
		if err != nil || len(apps.Items) != 1 || apps.Items[0].GrantID != grant {
			return errors.New("Team projection missing grant")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,repository_full_name,app_resource_id,team_grant_id,credential_version,claim_token,claim_until,claim_kind,access_hint_id,access_delivery_id,next_poll_at) VALUES($1,2,3,4,true,true,91,9,10,'owner/repo',$2,$3,1,$4,now()+interval '1 hour','poll',$5,'delivery',now())`, project, app, grant, uuid.NewString(), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,3,$2,'delivery',now(),now())`, project, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project); err != nil {
		t.Fatal(err)
	}
	revoke := func(impact int64, extra error) (store.Completion, error) {
		return db.WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error {
			if err := core.RevokeGrant(ctx, w, p, grant, core.RevokeGrantInput{ExpectedUserID: actor, Version: 1, ImpactVersion: impact}); err != nil {
				return err
			}
			return extra
		})
	}
	if c, err := revoke(1, nil); err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("stale impact: %+v %v", c, err)
	}
	abort := errors.New("abort")
	if c, err := revoke(2, abort); !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var enabled bool
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT enabled,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project).Scan(&enabled, &count); err != nil || !enabled || count != 1 {
		t.Fatalf("rollback persistence: %v %d %v", enabled, count, err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE project_github SET generation=$2 WHERE project_id=$1`, project, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	if c, err := revoke(2, nil); err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("overflow: %+v %v", c, err)
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE project_github SET generation=3 WHERE project_id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if c, err := revoke(2, nil); err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("revoke: %+v %v", c, err)
	}
	var clean bool
	if err := db.Pool.QueryRow(ctx, `SELECT NOT enabled AND NOT sync_enabled AND version=3 AND generation=4 AND revision=5 AND app_id IS NULL AND installation_id IS NULL AND app_resource_id IS NULL AND team_grant_id IS NULL AND credential_version IS NULL AND claim_token IS NULL AND access_hint_id IS NULL AND next_poll_at IS NULL AND repository_id=10 AND repository_full_name='owner/repo', (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1)+(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project).Scan(&clean, &count); err != nil || !clean || count != 1 {
		t.Fatalf("stop or PR retention: %v %d %v", clean, count, err)
	}
	if c, err := create(grant); err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old UUID reused: %+v %v", c, err)
	}
	if c, err := create(uuid.NewString()); err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("new grant: %+v %v", c, err)
	}
}

func TestGrantWaitsForTeamRoot(t *testing.T) {
	db, actor := dbFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	app, teamID := uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'team')`, teamID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,1,'a','a','a','k','s')`, app); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, app, actor); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, teamID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := db.WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error { _, e := w.Insert(ctx, uuid.NewString()); return e })
		done <- err
	}()
	var pid int
	deadline := time.Now().Add(5 * time.Second)
	for pid == 0 {
		if err := db.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%SELECT id::text FROM teams WHERE id=$1 FOR SHARE%' LIMIT 1),0)`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("grant did not wait for Team root")
		}
		if pid == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitForLock(t, db, pid)
	if _, err = tx.Exec(ctx, `DELETE FROM teams WHERE id=$1`, teamID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, model.ErrNotFound) || !errors.Is(err, store.ErrGitHubGrantTeamRootMissing) {
		t.Fatalf("deleted Team admitted: %v", err)
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("missing Team classified as database failure: %v", err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM github_app_team_grants WHERE team_id=$1`, teamID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("orphan grant count: %d %v", count, err)
	}
}

func TestGrantReadsRespectRolesAndPersonalPrivacy(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, personal, ordinary, outsider := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,personal_user_id,name) VALUES($1,$2,NULL)`, []any{personal, actor}},
		{`INSERT INTO teams(id,name) VALUES($1,'ordinary')`, []any{ordinary}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, []any{personal, actor, outsider}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,1,'app','remote','slug','k','s')`, []any{app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, actor}},
		{`INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3),($4,$5,$3)`, []any{uuid.NewString(), personal, app, uuid.NewString(), ordinary}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error {
		p, err := r.Preview(ctx, app, actor, personal)
		if err != nil || p.TargetTeam.Kind != "personal" || p.TargetTeam.Name != nil || p.Grant == nil {
			return errors.New("personal preview failed")
		}
		if _, err = r.Preview(ctx, app, outsider, personal); !errors.Is(err, model.ErrNotFound) {
			return errors.New("non-admin saw Team preview")
		}
		if _, err = r.TeamApps(ctx, personal, outsider, nil, 25); !errors.Is(err, model.ErrNotFound) {
			return errors.New("member saw Team apps")
		}
		first, err := r.Grants(ctx, app, actor, nil, 1)
		if err != nil || len(first.Items) != 1 || !first.HasMore {
			return errors.New("first grant page")
		}
		last := first.Items[0].ID
		second, err := r.Grants(ctx, app, actor, &last, 1)
		if err != nil || len(second.Items) != 1 || second.HasMore || second.Items[0].ID == last {
			return errors.New("second grant page")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// Unprivileged access is rejected before the target Team lock is attempted.
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM teams WHERE id=$1 FOR UPDATE`, personal); err != nil {
		t.Fatal(err)
	}
	bounded, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, err = db.WriteGitHubGrant(bounded, personal, app, outsider, func(store.GitHubGrantWriteDAO) error { return errors.New("called unauthorized operation") })
	if !errors.Is(err, model.ErrNotFound) || errors.Is(err, store.ErrGitHubGrantTeamRootMissing) {
		t.Fatalf("authorization should precede Team lock: %v", err)
	}
}

func TestGrantSharedStopSelectors(t *testing.T) {
	db, _ := dbFixture(t)
	ctx := t.Context()
	app, grant, first, second := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,1,'app','remote','slug','k','s')`, app); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,app_resource_id,team_grant_id,enabled,sync_enabled) VALUES($1,$3,$4,true,true),($2,$3,$4,true,true)`, first, second, app, grant); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, app); err != nil {
		t.Fatal(err)
	}
	stop := github.NewConnectionStopWriter(tx, app)
	if ok, err := stop.StopProjectConnection(ctx, first, uuid.NewString(), core.DisconnectionDecision()); err != nil || ok {
		t.Fatalf("wrong grant: %v %v", ok, err)
	}
	if ok, err := stop.StopProjectConnection(ctx, first, grant, core.DisconnectionDecision()); err != nil || !ok {
		t.Fatalf("stop project: %v %v", ok, err)
	}
	var n int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM project_github WHERE app_resource_id=$1 AND enabled`, app).Scan(&n); err != nil || n != 1 {
		t.Fatalf("project scope: %d %v", n, err)
	}
	if err = stop.StopAppConnections(ctx, core.DisconnectionDecision()); err != nil {
		t.Fatal(err)
	}
	if err = stop.AdvanceImpact(ctx); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github WHERE app_resource_id=$1 OR enabled OR sync_enabled`, app).Scan(&n); err != nil || n != 0 {
		t.Fatalf("App scope: %d %v", n, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT impact_version FROM github_apps WHERE id=$1`, app).Scan(&n); err != nil || n != 2 {
		t.Fatalf("impact scope: %d %v", n, err)
	}
}
