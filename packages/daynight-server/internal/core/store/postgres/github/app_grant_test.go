package github_test

import (
	"context"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
		if err := db.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock'
			AND query LIKE '%SELECT id::text FROM teams WHERE id=$1 FOR SHARE%'
			AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`, tx.Conn().PgConn().PID()).Scan(&pid); err != nil {
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
		{`INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,'Owner',now(),now())`, []any{actor}},
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

func TestGrantDAOFailuresAndBoundaries(t *testing.T) {
	db, actor := dbFixture(t)
	ctx := t.Context()
	app, teamID, grant := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'team')`, []any{teamID}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{teamID, actor}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,1,'app','remote','slug','k','s')`, []any{app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, actor}},
		{`INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, []any{grant, teamID, app}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("reads", func(t *testing.T) {
		tx := begin(t, db, pgx.TxOptions{})
		r := github.NewGrantReader(tx)
		if _, err := r.Grants(ctx, app, actor, nil, 0); err == nil {
			t.Fatal("invalid grant page limit accepted")
		}
		if _, err := r.TeamApps(ctx, teamID, actor, nil, 101); err == nil {
			t.Fatal("invalid Team app page limit accepted")
		}
		if _, err := r.Grants(ctx, app, uuid.NewString(), nil, 25); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("non-admin grant list: %v", err)
		}
		value, err := r.Grant(ctx, app, actor, grant)
		if err != nil || value.ID != grant {
			t.Fatalf("exact grant: %+v %v", value, err)
		}
		if _, err = r.Grant(ctx, app, uuid.NewString(), grant); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unauthorized grant: %v", err)
		}
		if _, err = r.Grant(ctx, app, actor, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing grant: %v", err)
		}
		loc, err := r.Locate(ctx, app, actor, grant)
		if err != nil || loc.TeamID != teamID || loc.Revoked {
			t.Fatalf("locate: %+v %v", loc, err)
		}
		if _, err = r.Locate(ctx, app, uuid.NewString(), grant); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("unauthorized locate: %v", err)
		}
		if _, err = r.Locate(ctx, app, actor, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing location: %v", err)
		}
		preview, err := r.Preview(ctx, app, actor, uuid.NewString())
		if !errors.Is(err, model.ErrNotFound) || preview.Grant != nil {
			t.Fatalf("missing Team preview: %+v %v", preview, err)
		}
	})
	t.Run("current facts", func(t *testing.T) {
		tx := begin(t, db, pgx.TxOptions{})
		w := github.NewGrantWriter(tx, teamID, app)
		g, err := w.LiveGrant(ctx)
		if err != nil || g == nil || g.ID != grant {
			t.Fatalf("live grant: %+v %v", g, err)
		}
		if _, err = w.Grant(ctx, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing locked grant: %v", err)
		}
		if _, err = github.NewGrantWriter(tx, uuid.NewString(), app).Facts(ctx, actor); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Team: %v", err)
		}
		if _, err = github.NewGrantWriter(tx, teamID, uuid.NewString()).Facts(ctx, actor); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing App: %v", err)
		}
		if err = w.Revoke(ctx, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing grant revoke: %v", err)
		}
	})
	t.Run("unique relationship", func(t *testing.T) {
		tx := begin(t, db, pgx.TxOptions{})
		w := github.NewGrantWriter(tx, teamID, app)
		if _, err := w.Insert(ctx, uuid.NewString()); !errors.Is(err, store.ErrGitHubGrantExists) {
			t.Fatalf("duplicate grant: %v", err)
		}
	})
	t.Run("impact exhausted", func(t *testing.T) {
		tx := begin(t, db, pgx.TxOptions{})
		mustExec(t, tx, `UPDATE github_apps SET impact_version=$2 WHERE id=$1`, app, int64(math.MaxInt64))
		w := github.NewGrantWriter(tx, teamID, app)
		var fault *model.Fault
		if err := w.AdvanceImpact(ctx); !errors.As(err, &fault) || fault.Code != "version_exhausted" {
			t.Fatalf("impact exhausted: %v", err)
		}
	})
	t.Run("live read cancellation", func(t *testing.T) {
		tx := begin(t, db, pgx.TxOptions{})
		w := github.NewGrantWriter(tx, teamID, app)
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		if _, err := w.LiveGrant(cancelled); err == nil {
			t.Fatal("cancelled grant read succeeded")
		}
	})
	waitAndCancel := func(t *testing.T, holder pgx.Tx, targetTeam string, action func(context.Context, store.GitHubGrantWriteDAO) error) {
		t.Helper()
		tx := begin(t, db, pgx.TxOptions{})
		var pid int
		if err := tx.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
		done := make(chan error, 1)
		go func() { done <- action(bounded, github.NewGrantWriter(tx, targetTeam, app)) }()
		received := false
		defer func() {
			cancel()
			if !received {
				<-done
			}
		}()
		waitForLock(t, db, pid)
		cancel()
		err := <-done
		received = true
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("waiting query cancellation: %v", err)
		}
		if err = holder.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
	}
	t.Run("insert waits for competing grant", func(t *testing.T) {
		targetTeam, proposed := uuid.NewString(), uuid.NewString()
		if _, err := db.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'other')`, targetTeam); err != nil {
			t.Fatal(err)
		}
		holder := begin(t, db, pgx.TxOptions{})
		mustExec(t, holder, `INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, uuid.NewString(), targetTeam, app)
		waitAndCancel(t, holder, targetTeam, func(ctx context.Context, w store.GitHubGrantWriteDAO) error {
			_, err := w.Insert(ctx, proposed)
			return err
		})
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM github_app_team_grants WHERE team_id=$1`, targetTeam).Scan(&count); err != nil || count != 0 {
			t.Fatalf("cancelled insert persisted: %d %v", count, err)
		}
	})
	t.Run("revoke waits for grant", func(t *testing.T) {
		holder := begin(t, db, pgx.TxOptions{})
		mustExec(t, holder, `SELECT id FROM github_app_team_grants WHERE id=$1 FOR UPDATE`, grant)
		waitAndCancel(t, holder, teamID, func(ctx context.Context, w store.GitHubGrantWriteDAO) error { return w.Revoke(ctx, grant) })
		var active bool
		if err := db.Pool.QueryRow(ctx, `SELECT revoked_at IS NULL FROM github_app_team_grants WHERE id=$1`, grant).Scan(&active); err != nil || !active {
			t.Fatalf("cancelled revoke changed grant: %v %v", active, err)
		}
	})
	t.Run("impact waits for App", func(t *testing.T) {
		holder := begin(t, db, pgx.TxOptions{})
		mustExec(t, holder, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, app)
		waitAndCancel(t, holder, teamID, func(ctx context.Context, w store.GitHubGrantWriteDAO) error { return w.AdvanceImpact(ctx) })
		var version int64
		if err := db.Pool.QueryRow(ctx, `SELECT impact_version FROM github_apps WHERE id=$1`, app).Scan(&version); err != nil || version != 1 {
			t.Fatalf("cancelled impact changed version: %d %v", version, err)
		}
	})
	t.Run("stop waits for connection", func(t *testing.T) {
		project := uuid.NewString()
		if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,app_resource_id,team_grant_id,enabled,sync_enabled) VALUES($1,$2,$3,true,true)`, project, app, grant); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,1,$2,'x',now(),now())`, project, uuid.NewString()); err != nil {
			t.Fatal(err)
		}
		holder := begin(t, db, pgx.TxOptions{})
		mustExec(t, holder, `SELECT project_id FROM project_github WHERE project_id=$1 FOR UPDATE`, project)
		waitAndCancel(t, holder, teamID, func(ctx context.Context, w store.GitHubGrantWriteDAO) error {
			return w.StopGrantConnections(ctx, grant, core.DisconnectionDecision())
		})
		var intact bool
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT enabled AND sync_enabled AND team_grant_id=$2,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project, grant).Scan(&intact, &count); err != nil || !intact || count != 1 {
			t.Fatalf("cancelled stop changed data: %v %d %v", intact, count, err)
		}
	})
}

func TestGrantPersonalOwnerProjection(t *testing.T) {
	db, admin := dbFixture(t)
	ctx := t.Context()
	app := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,1,'app','remote','slug','k','s')`, app); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, app, admin); err != nil {
		t.Fatal(err)
	}
	alice, bob, blank, empty := "Alice", "Bob", " \u2003 ", ""
	cases := []struct {
		team, owner, grant string
		name               *string
	}{
		{uuid.NewString(), uuid.NewString(), uuid.NewString(), &alice},
		{uuid.NewString(), uuid.NewString(), uuid.NewString(), &bob},
		{uuid.NewString(), uuid.NewString(), uuid.NewString(), &blank},
		{uuid.NewString(), uuid.NewString(), uuid.NewString(), &empty},
		{uuid.NewString(), uuid.NewString(), uuid.NewString(), nil},
	}
	for _, tc := range cases {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,$2,now(),now())`, tc.owner, tc.name); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Pool.Exec(ctx, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, tc.team, tc.owner); err != nil {
			t.Fatal(err)
		}
		check := func(team store.GitHubGrantTeam) error {
			if team.ID != tc.team || team.Kind != "personal" || team.Name != nil || team.PersonalOwner == nil || team.PersonalOwner.UserID != tc.owner || (team.PersonalOwner.Name == nil) != (tc.name == nil) || tc.name != nil && *team.PersonalOwner.Name != *tc.name {
				return fmt.Errorf("unexpected team projection: %+v", team)
			}
			return nil
		}
		if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error {
			p, err := r.Preview(ctx, app, admin, tc.team)
			if err != nil {
				return err
			}
			if p.Grant != nil {
				return errors.New("unexpected existing grant")
			}
			return check(p.TargetTeam)
		}); err != nil {
			t.Fatal(err)
		}
		completion, err := db.WriteGitHubGrant(ctx, tc.team, app, admin, func(w store.GitHubGrantWriteDAO) error {
			facts, err := w.Facts(ctx, admin)
			if err != nil {
				return err
			}
			if err = check(facts.Team); err != nil {
				return err
			}
			g, err := w.Insert(ctx, tc.grant)
			if err != nil {
				return err
			}
			return check(g.Team)
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("insert: %+v %v", completion, err)
		}
		if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error {
			p, err := r.Preview(ctx, app, admin, tc.team)
			if err != nil {
				return err
			}
			if p.Grant == nil {
				return errors.New("missing grant")
			}
			if err = check(p.TargetTeam); err != nil {
				return err
			}
			if err = check(p.Grant.Team); err != nil {
				return err
			}
			g, err := r.Grant(ctx, app, admin, tc.grant)
			if err != nil {
				return err
			}
			return check(g.Team)
		}); err != nil {
			t.Fatal(err)
		}
	}
	ordinary, ordinaryGrant := uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'Ordinary')`, ordinary); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, ordinaryGrant, ordinary, app); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error {
		page, err := r.Grants(ctx, app, admin, nil, 25)
		if err != nil {
			return err
		}
		if len(page.Items) != len(cases)+1 {
			return fmt.Errorf("got %d grants", len(page.Items))
		}
		for _, g := range page.Items {
			if g.Team.ID == ordinary {
				if g.Team.Kind != "ordinary" || g.Team.Name == nil || *g.Team.Name != "Ordinary" || g.Team.PersonalOwner != nil {
					return fmt.Errorf("ordinary projection: %+v", g.Team)
				}
				continue
			}
			found := false
			for _, tc := range cases {
				if g.Team.ID == tc.team {
					found = g.Team.PersonalOwner != nil && g.Team.PersonalOwner.UserID == tc.owner && ((tc.name == nil && g.Team.PersonalOwner.Name == nil) || (tc.name != nil && g.Team.PersonalOwner.Name != nil && *tc.name == *g.Team.PersonalOwner.Name))
				}
			}
			if !found {
				return fmt.Errorf("wrong owner: %+v", g.Team)
			}
		}
		_, err = r.Grants(ctx, app, uuid.NewString(), nil, 25)
		if !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("non-admin list: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, cases[0].owner); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error { _, err := r.Grants(ctx, app, admin, nil, 25); return err }); err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing owner must be an integrity error: %v", err)
	}
	if err := db.ReadGitHubGrants(ctx, func(r store.GitHubGrantReadDAO) error {
		_, err := r.Preview(ctx, app, admin, cases[0].team)
		return err
	}); err == nil || errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing preview owner must be an integrity error: %v", err)
	}
}
