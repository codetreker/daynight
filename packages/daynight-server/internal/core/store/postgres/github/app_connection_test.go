package github_test

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type projectAppFixture struct {
	db                        *postgres.Store
	p                         model.Principal
	project, team, app, grant string
}

func newProjectAppFixture(t *testing.T) projectAppFixture {
	t.Helper()
	db, actor := dbFixture(t)
	f := projectAppFixture{db: db, p: model.Principal{Kind: model.SessionCredential, UserID: actor, CredentialID: uuid.NewString()}, project: uuid.NewString(), team: uuid.NewString(), app: uuid.NewString(), grant: uuid.NewString()}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::text,now(),now())`, []any{actor}},
		{`INSERT INTO teams(id,name) VALUES($1,'Team')`, []any{f.team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{f.team, actor}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','https://github.com/o/r')`, []any{f.project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{f.project, f.team}},
		{`INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,9,'App','Remote','remote','key','secret')`, []any{f.app}},
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{f.app, actor}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, []any{f.grant, f.app, f.team}},
	} {
		if _, err := db.Pool.Exec(t.Context(), q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return f
}
func (f projectAppFixture) write(ctx context.Context, action string, version int64, extra error) (core.ProjectAppStatus, store.Completion, error) {
	in := core.ProjectAppConnect{ProjectAppSelection: core.ProjectAppSelection{AppResourceID: f.app, GrantID: f.grant, AppVersion: 1, OwnershipVersion: 1}, Version: version, InstallationID: 7, RepositoryVersion: 1}
	proof := core.InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 7, AccountLogin: "o"}, Repository: githubpr.RepositoryObservation{ID: 8, FullName: "o/r"}}
	var out core.ProjectAppStatus
	c, err := f.db.WriteGitHubProjectApp(ctx, f.project, f.p.UserID, f.app, func(d store.GitHubProjectAppWriteDAO) error {
		var e error
		out, e = core.ManageProjectApp(ctx, d, f.p, action, in, 10, true, "https://github.com/o/r", proof)
		if e != nil {
			return e
		}
		return extra
	})
	return out, c, err
}

func TestProjectAppConnectionPersistenceAndRollback(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if err := f.db.ReadGitHubProjectApp(ctx, f.project, func(d store.GitHubProjectAppReadDAO) error {
		facts, err := d.Facts(ctx, f.p)
		if err != nil {
			return err
		}
		if facts.Connection.Version != 1 || facts.AppResourceID != nil {
			t.Fatalf("default %+v", facts)
		}
		_, err = d.App(ctx, f.app, f.grant, uuid.NewString())
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("wrong Team grant: %v", err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	abort := errors.New("abort")
	if _, c, err := f.write(ctx, "connect", 1, abort); !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var count int
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rolled back row: %d %v", count, err)
	}
	out, c, err := f.write(ctx, "connect", 1, nil)
	if err != nil || c.Outcome != store.TransactionCommitted || !out.CanManageConnection || out.App == nil || out.App.ID != f.app || out.Connection.SyncEnabled {
		t.Fatalf("connect: %+v %+v %v", out, c, err)
	}
	if _, c, err = f.write(ctx, "connect", 1, nil); err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("stale: %+v %v", c, err)
	}
	if _, _, err = f.write(ctx, "sync", 2, nil); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `UPDATE project_github SET claim_token=$2,claim_kind='poll',claim_until=now()+interval '1 hour',not_before=now()+interval '1 hour',access_hint_id=$3,access_delivery_id='delivery' WHERE project_id=$1`, f.project, uuid.NewString(), uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,2,$2,'delivery',now(),now())`, f.project, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, _, err = f.write(ctx, "disconnect", 3, nil); err != nil {
		t.Fatal(err)
	}
	var stopped bool
	var impact int64
	err = f.db.Pool.QueryRow(ctx, `SELECT NOT enabled AND NOT sync_enabled AND app_resource_id IS NULL AND team_grant_id IS NULL AND credential_version IS NULL AND app_id IS NULL AND installation_id IS NULL AND repository_id=8 AND claim_token IS NULL AND not_before IS NULL AND access_hint_id IS NULL AND next_poll_at IS NULL,(SELECT impact_version FROM github_apps WHERE id=$2),(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project, f.app).Scan(&stopped, &impact, &count)
	if err != nil || !stopped || impact != 3 || count != 0 {
		t.Fatalf("durable stop: %v %d %d %v", stopped, impact, count, err)
	}
	if _, _, err = f.write(ctx, "disconnect", 4, nil); err != nil {
		t.Fatal(err)
	}
}

func TestProjectAppSyncPreservesRateLimitBackoff(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
		t.Fatal(err)
	}
	backoff := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	if _, err := f.db.Pool.Exec(ctx, `UPDATE project_github SET not_before=$2 WHERE project_id=$1`, f.project, backoff); err != nil {
		t.Fatal(err)
	}
	version := int64(2)
	for _, enabled := range []bool{true, false, true} {
		c, err := f.db.WriteGitHubProjectApp(ctx, f.project, f.p.UserID, "", func(d store.GitHubProjectAppWriteDAO) error {
			_, e := core.ManageProjectApp(ctx, d, f.p, "sync", core.ProjectAppConnect{Version: version}, 0, enabled, "", core.InstallationCandidate{})
			return e
		})
		if err != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("sync %v: %+v %v", enabled, c, err)
		}
		version++
		var retained time.Time
		if err = f.db.Pool.QueryRow(ctx, `SELECT not_before FROM project_github WHERE project_id=$1`, f.project).Scan(&retained); err != nil || !retained.Equal(backoff) {
			t.Fatalf("sync %v erased rate limit: %v %v", enabled, retained, err)
		}
	}
}

func TestProjectAppConnectionWaitsForDeletionAndRereads(t *testing.T) {
	for _, kind := range []string{"App deletion", "grant revocation"} {
		t.Run(kind, func(t *testing.T) {
			f := newProjectAppFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			if _, _, err := f.write(ctx, "connect", 1, nil); err != nil {
				t.Fatal(err)
			}
			tx := begin(t, f.db, pgx.TxOptions{})
			mustExec(t, tx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, f.app)
			done := make(chan error, 1)
			go func() { _, _, err := f.write(ctx, "disconnect", 2, nil); done <- err }()
			deadline := time.Now().Add(5 * time.Second)
			for {
				var waiting bool
				err := f.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT id::text FROM github_apps%FOR UPDATE')`, int(tx.Conn().PgConn().PID())).Scan(&waiting)
				if err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("connection manager did not wait for App root")
				}
				time.Sleep(10 * time.Millisecond)
			}
			stop := github.NewConnectionStopWriter(tx, f.app)
			if kind == "App deletion" {
				if err := stop.StopAppConnections(ctx, core.DisconnectionDecision()); err != nil {
					t.Fatal(err)
				}
				mustExec(t, tx, `UPDATE github_apps SET deleted_at=now(),private_key_pem=NULL,webhook_secret=NULL WHERE id=$1`, f.app)
			} else {
				if err := stop.StopGrantConnections(ctx, f.grant, core.DisconnectionDecision()); err != nil {
					t.Fatal(err)
				}
			}
			mustExec(t, tx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, f.grant)
			if err := tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var fault *model.Fault
			if err := <-done; !errors.As(err, &fault) || fault.Code != "version_conflict" {
				t.Fatalf("stale disconnect did not observe cleanup version: %v", err)
			}
			if _, _, err := f.write(ctx, "disconnect", 3, nil); err != nil {
				t.Fatalf("cleaned binding reread: %v", err)
			}
			var version int64
			var cleared bool
			if err := f.db.Pool.QueryRow(ctx, `SELECT version,app_resource_id IS NULL AND NOT enabled FROM project_github WHERE project_id=$1`, f.project).Scan(&version, &cleared); err != nil || version != 3 || !cleared {
				t.Fatalf("no duplicate stop: %d %v %v", version, cleared, err)
			}
		})
	}
}

func TestProjectAppDAOCancellationAndIdentityConditions(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	tx := begin(t, f.db, pgx.TxOptions{})
	d := github.NewProjectAppWriter(tx, f.project)
	w := store.GitHubProjectAppWrite{Configuration: store.GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, Generation: 1, Revision: 1, PollIntervalMinutes: 5, AccessState: "unknown"}}
	if ok, err := d.Save(ctx, w); err != nil || !ok {
		t.Fatalf("save default %v %v", ok, err)
	}
	if ok, err := d.Save(ctx, w); err != nil || ok {
		t.Fatalf("stale save %v %v", ok, err)
	}
	w.Configuration.ExpectedVersion = 2
	w.Configuration.Version = 3
	w.AppResourceID = &f.app
	bad := uuid.NewString()
	w.GrantID = &bad
	w.CredentialVersion = ptr(int64(1))
	if _, err := d.Save(ctx, w); err == nil {
		t.Fatal("saved unrelated grant")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	closed := github.NewProjectAppWriter(tx, f.project)
	if _, err := closed.Facts(ctx, f.p); err == nil {
		t.Fatal("closed facts")
	}
	if _, err := closed.App(ctx, f.app, f.grant, f.team); err == nil {
		t.Fatal("closed App")
	}
	if _, err := closed.Save(ctx, w); err == nil {
		t.Fatal("closed save")
	}
	if err := closed.AdvanceImpact(ctx, f.app); err == nil {
		t.Fatal("closed impact")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := f.db.WriteGitHubProjectApp(cancelled, f.project, f.p.UserID, f.app, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("cancelled callback"); return nil }); err == nil {
		t.Fatal("cancelled transaction")
	}
	if _, err := f.db.WriteGitHubProjectApp(ctx, uuid.NewString(), f.p.UserID, f.app, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("missing callback"); return nil }); err == nil {
		t.Fatal("missing project")
	}
	if _, err := f.db.WriteGitHubProjectApp(ctx, f.project, uuid.NewString(), f.app, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("unauthorized callback"); return nil }); err == nil {
		t.Fatal("unauthorized project")
	}
}

func TestProjectAppDAOQueryFailures(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	for _, tc := range []struct {
		name, breakSQL string
		save           bool
	}{
		{"project projection", `ALTER TABLE projects RENAME COLUMN repo_url TO broken_url`, false},
		{"connection projection", `ALTER TABLE project_github RENAME COLUMN enabled TO broken_enabled`, false},
		{"connection identity", `ALTER TABLE project_github RENAME COLUMN app_resource_id TO broken_app`, false},
		{"save identity", `ALTER TABLE project_github RENAME COLUMN app_resource_id TO broken_app`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := begin(t, f.db, pgx.TxOptions{})
			mustExec(t, tx, tc.breakSQL)
			d := github.NewProjectAppWriter(tx, f.project)
			var err error
			if tc.save {
				_, err = d.Save(ctx, store.GitHubProjectAppWrite{Configuration: store.GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, Generation: 1, Revision: 1, PollIntervalMinutes: 5, AccessState: "unknown"}})
			} else {
				_, err = d.Facts(ctx, f.p)
			}
			if err == nil {
				t.Fatal("database failure hidden")
			}
			if failed, _ := store.DatabaseErrorFacts(err); !failed {
				t.Fatalf("database cause lost: %v", err)
			}
			if err = tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}
