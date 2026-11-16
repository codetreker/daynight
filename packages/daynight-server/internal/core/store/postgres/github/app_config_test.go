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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAppConfigPersistenceFenceAndRemoval(t *testing.T) {
	db, app, actor, other := appAdminFixture(t)
	ctx := t.Context()
	grant, project, disabled, unrelated := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, []any{app, other}},
		{`INSERT INTO github_app_admin_invitations(id,app_resource_id,token_hash,created_by,issuer_membership_version,created_at,expires_at) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')`, []any{uuid.NewString(), app, []byte("hash"), actor}},
		{`INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, []any{grant, app, uuid.NewString()}},
		{`INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,repository_full_name,app_resource_id,team_grant_id,credential_version,claim_token,claim_until,claim_kind,access_hint_id,access_delivery_id,next_poll_at) VALUES($1,2,3,4,true,true,123,9,10,'owner/repo',$2,$3,1,$4,now()+interval '1 hour','poll',$5,'delivery',now()),($6,2,3,4,true,false,123,9,10,'owner/repo',$2,$3,1,NULL,NULL,NULL,NULL,NULL,NULL)`, []any{project, app, grant, uuid.NewString(), uuid.NewString(), disabled}},
		{`INSERT INTO project_github(project_id,app_resource_id,credential_version,generation,revision) VALUES($1,$2,7,8,9)`, []any{unrelated, uuid.NewString()}},
		{`INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,3,$2,'delivery',now(),now())`, []any{project, uuid.NewString()}},
		{`INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, []any{project}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	read := func(actorID string) (store.GitHubAppConfigFacts, error) {
		var f store.GitHubAppConfigFacts
		err := db.ReadGitHubAppConfig(ctx, app, func(r store.GitHubAppConfigReader) error { var err error; f, err = r.Facts(ctx, actorID); return err })
		return f, err
	}
	f, err := read(actor)
	if err != nil || f.App.Version != 1 || f.CredentialVersion != 1 || f.ImpactVersion != 1 || f.MembershipVersion < 1 || !f.HasImpact || string(f.Credentials.PrivateKeyPEM) != "key" {
		t.Fatalf("facts: %+v %v", f, err)
	}
	if _, err = read(uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing actor: %v", err)
	}
	abort := errors.New("abort")
	update := func(extra error) (store.Completion, error) {
		return db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error {
			if err := w.FenceConnections(ctx, store.GitHubAppCredentialFence{CredentialVersion: 2, AccessState: "unknown", ScheduleSyncAccess: true}); err != nil {
				return err
			}
			_, err := w.Update(ctx, store.GitHubAppConfigUpdate{Name: "New", GitHubName: "Remote new", GitHubSlug: "remote-new", Version: 2, CredentialVersion: 2, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("new key"), WebhookSecret: []byte("new secret")}})
			if err != nil {
				return err
			}
			return extra
		})
	}
	if c, err := update(abort); !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	f, err = read(actor)
	if err != nil || f.App.Version != 1 || string(f.Credentials.PrivateKeyPEM) != "key" {
		t.Fatalf("rollback readback: %+v %v", f, err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE project_github SET generation=$2 WHERE project_id=$1`, project, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	if c, err := update(nil); err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("overflow: %+v %v", c, err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE project_github SET generation=3 WHERE project_id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if c, err := update(nil); err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("update: %+v %v", c, err)
	}
	f, err = read(actor)
	if err != nil || f.App.Version != 2 || f.CredentialVersion != 2 || f.App.Name != "New" || string(f.Credentials.WebhookSecret) != "new secret" {
		t.Fatalf("updated: %+v %v", f, err)
	}
	var ok bool
	err = db.Pool.QueryRow(ctx, `SELECT enabled AND sync_enabled AND app_resource_id=$2 AND team_grant_id=$3 AND credential_version=2 AND generation=4 AND revision=5 AND version=2 AND access_state='unknown' AND access_hint_id IS NULL AND claim_token IS NULL AND next_access_check_at IS NOT NULL AND next_poll_at IS NULL AND repository_id=10 AND (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1)=0 AND (SELECT count(*) FROM project_pull_requests WHERE project_id=$1)=1 FROM project_github WHERE project_id=$1`, project, app, grant).Scan(&ok)
	if err != nil || !ok {
		t.Fatalf("fence: %v %v", ok, err)
	}
	err = db.Pool.QueryRow(ctx, `SELECT credential_version=2 AND generation=4 AND revision=5 AND next_access_check_at IS NULL AND NOT sync_enabled FROM project_github WHERE project_id=$1`, disabled).Scan(&ok)
	if err != nil || !ok {
		t.Fatalf("disabled fence: %v %v", ok, err)
	}
	remove := func(extra error) (store.Completion, error) {
		return db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error {
			if err := w.RemoveRelations(ctx); err != nil {
				return err
			}
			if err := w.StopAppConnections(ctx, store.GitHubStopDecision{AccessState: "unknown"}); err != nil {
				return err
			}
			if err := w.Tombstone(ctx, 2); err != nil {
				return err
			}
			return extra
		})
	}
	if c, err := remove(abort); !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("remove rollback: %+v %v", c, err)
	}
	if _, err = read(actor); err != nil {
		t.Fatalf("rollback app missing: %v", err)
	}
	if c, err := remove(nil); err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("remove: %+v %v", c, err)
	}
	if _, err = read(actor); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted read: %v", err)
	}
	err = db.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL AND private_key_pem IS NULL AND webhook_secret IS NULL AND impact_version=2 AND (SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1)=0 AND (SELECT count(*) FROM github_app_admin_invitations WHERE app_resource_id=$1)=0 AND (SELECT count(*) FROM github_app_team_grants WHERE app_resource_id=$1 AND revoked_at IS NULL)=0 AND (SELECT count(*) FROM github_app_team_grants WHERE id=$2 AND revoked_at IS NOT NULL)=1 AND (SELECT count(*) FROM project_github WHERE app_resource_id=$1)=0 AND (SELECT count(*) FROM project_pull_requests WHERE project_id=$3)=1 FROM github_apps WHERE id=$1`, app, grant, project).Scan(&ok)
	if err != nil || !ok {
		t.Fatalf("removal persistence: %v %v", ok, err)
	}
	err = db.Pool.QueryRow(ctx, `SELECT credential_version=7 AND generation=8 AND revision=9 FROM project_github WHERE project_id=$1`, unrelated).Scan(&ok)
	if err != nil || !ok {
		t.Fatalf("unrelated: %v %v", ok, err)
	}
	c, err := db.WriteGitHubApp(ctx, func(w store.GitHubAppWriteDAO) error {
		_, e := w.Create(ctx, store.GitHubAppCreate{ID: app, GitHubAppID: 123, Name: "New", CreatorUserID: actor, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}})
		return e
	})
	if !errors.Is(err, store.ErrGitHubAppResourceIDConflict) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("reused ID: %+v %v", c, err)
	}
}

func TestAppConfigSerializesMembershipAndReadsNewVersion(t *testing.T) {
	db, app, actor, other := appAdminFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var before int64
	var initial store.GitHubAppConfigFacts
	if err := db.ReadGitHubAppConfig(ctx, app, func(r store.GitHubAppConfigReader) error {
		f, err := r.Facts(ctx, actor)
		before = f.MembershipVersion
		initial = f
		return err
	}); err != nil {
		t.Fatal(err)
	}
	adminWrite(t, db, app, func(w store.GitHubAppAdminWriter) error { _, err := w.AddAdmin(ctx, app, other); return err })
	// A single-connection pool gives the waiting scope a known backend PID.
	cfg := db.Pool.Config()
	cfg.MaxConns = 1
	waitPool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer waitPool.Close()
	var waiterPID int32
	if err := waitPool.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&waiterPID); err != nil {
		t.Fatal(err)
	}
	waitDB := &postgres.Store{Pool: waitPool}
	type result struct {
		completion store.Completion
		err        error
	}
	done := make(chan result, 1)
	consumed := false
	c, err := db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error {
		go func() {
			completion, e := waitDB.WriteGitHubAppAdmins(ctx, app, func(w store.GitHubAppAdminWriter) error {
				if err := w.RemoveAdmin(ctx, app, actor, before); err != nil {
					return err
				}
				_, err := w.AddAdmin(ctx, app, actor)
				return err
			})
			done <- result{completion, e}
		}()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			var waiting bool
			if err := db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND query LIKE 'SELECT id::text FROM github_apps%FOR UPDATE')`, waiterPID).Scan(&waiting); err != nil {
				return err
			}
			if waiting {
				return nil
			}
			select {
			case r := <-done:
				consumed = true
				return fmt.Errorf("admin write ended before observed lock wait: %v", r.err)
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
			}
		}
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		cancel()
		if !consumed {
			<-done
		}
		t.Fatalf("config lock: %+v %v", c, err)
	}
	r := <-done
	if r.err != nil || r.completion.Outcome != store.TransactionCommitted {
		t.Fatalf("admin write: %+v %v", r.completion, r.err)
	}
	replacement := "replacement secret"
	proof := &core.AppUpdateProof{MembershipVersion: before, Version: initial.App.Version, GitHubAppID: initial.App.GitHubAppID, GitHubName: initial.App.GitHubName, GitHubSlug: initial.App.GitHubSlug}
	c, err = db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error {
		_, err := core.UpdateApp(ctx, w, model.Principal{UserID: actor, Kind: model.SessionCredential, CredentialID: uuid.NewString()}, core.UpdateAppInput{Version: initial.App.Version, ExpectedUserID: actor, WebhookSecret: &replacement}, proof)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "github_admin_changed" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old proof: %+v %v", c, err)
	}
	if err := db.ReadGitHubAppConfig(ctx, app, func(r store.GitHubAppConfigReader) error {
		f, err := r.Facts(ctx, actor)
		if err == nil && (f.MembershipVersion == before || f.App.Version != initial.App.Version || f.CredentialVersion != initial.CredentialVersion || string(f.Credentials.WebhookSecret) != string(initial.Credentials.WebhookSecret)) {
			t.Fatalf("old proof changed configuration or membership version was reused: %+v", f.App)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAppConfigDatabaseFailuresRollback(t *testing.T) {
	for _, tc := range []struct {
		name, breakSQL, repairSQL string
		operation                 func(context.Context, store.GitHubAppConfigWriter) error
	}{
		{"update projection", `ALTER TABLE github_app_admins RENAME TO broken_admins`, `ALTER TABLE broken_admins RENAME TO github_app_admins`, func(ctx context.Context, w store.GitHubAppConfigWriter) error {
			_, err := w.Update(ctx, store.GitHubAppConfigUpdate{Name: "changed", GitHubName: "Remote", GitHubSlug: "remote", Version: 2, CredentialVersion: 1, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}})
			return err
		}},
		{"fence pending", `ALTER TABLE project_github_pending_prs RENAME TO broken_pending`, `ALTER TABLE broken_pending RENAME TO project_github_pending_prs`, func(ctx context.Context, w store.GitHubAppConfigWriter) error {
			return w.FenceConnections(ctx, store.GitHubAppCredentialFence{CredentialVersion: 2, AccessState: "unknown", ScheduleSyncAccess: true})
		}},
		{"fence update", `ALTER TABLE project_github RENAME COLUMN access_state TO broken_access_state`, `ALTER TABLE project_github RENAME COLUMN broken_access_state TO access_state`, func(ctx context.Context, w store.GitHubAppConfigWriter) error {
			return w.FenceConnections(ctx, store.GitHubAppCredentialFence{CredentialVersion: 2, AccessState: "unknown", ScheduleSyncAccess: true})
		}},
		{"remove relations", `ALTER TABLE github_app_admins RENAME TO broken_admins`, `ALTER TABLE broken_admins RENAME TO github_app_admins`, func(ctx context.Context, w store.GitHubAppConfigWriter) error { return w.RemoveRelations(ctx) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, app, actor, _ := appAdminFixture(t)
			ctx := t.Context()
			project := uuid.NewString()
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO project_github(project_id,app_resource_id,generation,revision) VALUES($1,$2,3,4)`, []any{project, app}},
				{`INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,3,$2,'delivery',now(),now())`, []any{project, uuid.NewString()}},
				{`INSERT INTO github_app_admin_invitations(id,app_resource_id,token_hash,created_by,issuer_membership_version,created_at,expires_at) VALUES($1,$2,$3,$4,1,now(),now()+interval '1 day')`, []any{uuid.NewString(), app, []byte("hash"), actor}},
			} {
				if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Pool.Exec(ctx, tc.breakSQL); err != nil {
				t.Fatal(err)
			}
			c, err := db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error { return tc.operation(ctx, w) })
			if err == nil || c.Outcome != store.TransactionNotCommitted {
				t.Fatalf("failure completion: %+v %v", c, err)
			}
			if failed, _ := store.DatabaseErrorFacts(err); !failed {
				t.Fatalf("missing database cause: %v", err)
			}
			if _, err := db.Pool.Exec(ctx, tc.repairSQL); err != nil {
				t.Fatal(err)
			}
			var intact bool
			err = db.Pool.QueryRow(ctx, `SELECT name='Automation' AND version=1 AND private_key_pem='key'::bytea AND (SELECT count(*) FROM github_app_admin_invitations WHERE app_resource_id=$1)=1 AND (SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1)=1 AND (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$2)=1 AND (SELECT generation=3 AND revision=4 FROM project_github WHERE project_id=$2) FROM github_apps WHERE id=$1`, app, project).Scan(&intact)
			if err != nil || !intact {
				t.Fatalf("rollback: %v %v", intact, err)
			}
		})
	}
}

func TestAppConfigMissingAndCancelledWrites(t *testing.T) {
	db, app, _, _ := appAdminFixture(t)
	ctx := t.Context()
	input := store.GitHubAppConfigUpdate{Name: "New", GitHubName: "Remote", GitHubSlug: "remote", Version: 2, CredentialVersion: 1, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}}
	tx := begin(t, db, pgx.TxOptions{})
	absent := github.NewAppConfigWriter(tx, uuid.NewString())
	if _, err := absent.Update(ctx, input); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing update: %v", err)
	}
	if err := absent.Tombstone(ctx, 1); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing tombstone: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, op := range []func(context.Context, store.GitHubAppConfigWriter) error{
		func(ctx context.Context, w store.GitHubAppConfigWriter) error {
			_, err := w.Update(ctx, input)
			return err
		},
		func(ctx context.Context, w store.GitHubAppConfigWriter) error { return w.Tombstone(ctx, 1) },
		func(ctx context.Context, w store.GitHubAppConfigWriter) error {
			return w.FenceConnections(ctx, store.GitHubAppCredentialFence{})
		},
	} {
		c, err := db.WriteGitHubAppConfig(ctx, app, func(w store.GitHubAppConfigWriter) error {
			canceled, stop := context.WithCancel(ctx)
			stop()
			return op(canceled, w)
		})
		if !errors.Is(err, context.Canceled) || c.Outcome != store.TransactionNotCommitted {
			t.Fatalf("cancelled: %+v %v", c, err)
		}
	}
}
