package postgres

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	githubdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func appAdminScopeFixture(t *testing.T) (*Store, string, model.Principal, model.Principal, model.Principal) {
	t.Helper()
	db := isolatedStore(t)
	users := []model.Principal{{UserID: uuid.NewString()}, {UserID: uuid.NewString()}, {UserID: uuid.NewString()}}
	for _, p := range users {
		mustQueryExec(t, db, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, p.UserID, p.UserID)
	}
	appID := uuid.NewString()
	c, err := db.WriteGitHubApp(t.Context(), func(w store.GitHubAppWriteDAO) error {
		_, err := w.Create(t.Context(), store.GitHubAppCreate{ID: appID, GitHubAppID: 123, Name: "Automation", GitHubName: "Remote", GitHubSlug: "remote", CreatorUserID: users[0].UserID, Credentials: githubpr.AppCredentials{PrivateKeyPEM: []byte("key"), WebhookSecret: []byte("secret")}})
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("create fixture: %+v %v", c, err)
	}
	return db, appID, users[0], users[1], users[2]
}

func mintAppAdminInvitation(t *testing.T, db *Store, appID string, actor model.Principal) coregithub.MintedAdminInvitation {
	t.Helper()
	var minted coregithub.MintedAdminInvitation
	c, err := db.WriteGitHubAppAdmins(t.Context(), appID, func(w store.GitHubAppAdminWriter) error {
		var err error
		minted, err = coregithub.CreateAdminInvitation(t.Context(), w, actor, appID)
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("mint invitation: %+v %v", c, err)
	}
	return minted
}

func readAppAdminMembership(t *testing.T, db *Store, appID, userID string) githubpr.AdminMembership {
	t.Helper()
	var member githubpr.AdminMembership
	if err := db.ReadGitHubAppAdmins(t.Context(), func(r store.GitHubAppAdminReader) error {
		var err error
		member, err = r.Membership(t.Context(), appID, userID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return member
}

func serializedAppAdminOperations(t *testing.T, db *Store, appID string, first, second func(context.Context, store.GitHubAppAdminWriter) error) (store.Completion, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	type result struct {
		completion store.Completion
		err        error
	}
	done := make(chan result, 1)
	started, received := false, false
	defer func() {
		cancel()
		if started && !received {
			<-done
		}
	}()
	c, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		if err := first(ctx, w); err != nil {
			return err
		}
		started = true
		go func() {
			completion, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error { return second(ctx, w) })
			done <- result{completion, err}
		}()
		waitForQueryLock(t, db, "SELECT id::text FROM github_apps WHERE")
		return nil
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("first serialized mutation: %+v %v", c, err)
	}
	select {
	case r := <-done:
		received = true
		return r.completion, r.err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return store.Completion{}, ctx.Err()
	}
}

func TestAppAdminScopeSerializesAcceptAndRevoke(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, acceptFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoke first", true: "accept first"}[acceptFirst], func(t *testing.T) {
			db, appID, issuer, joiner, _ := appAdminScopeFixture(t)
			invite := mintAppAdminInvitation(t, db, appID, issuer)
			var accepted coregithub.AdminInvitationAcceptance
			var revoked coregithub.AdminInvitationRevocation
			accept := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				var err error
				accepted, err = coregithub.AcceptAdminInvitation(ctx, w, joiner, invite.Secret)
				return err
			}
			revoke := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				var err error
				revoked, err = coregithub.RevokeAdminInvitation(ctx, w, issuer, appID, invite.Invitation.ID)
				return err
			}
			first, second := revoke, accept
			if acceptFirst {
				first, second = accept, revoke
			}
			c, err := serializedAppAdminOperations(t, db, appID, first, second)
			if acceptFirst {
				if err != nil || c.Outcome != store.TransactionCommitted || !accepted.Joined || revoked.Changed {
					t.Fatalf("accept then revoke: %+v %+v %+v %v", accepted, revoked, c, err)
				}
				if got := readAppAdminMembership(t, db, appID, joiner.UserID); got.Version != accepted.Membership.Version {
					t.Fatalf("accepted membership changed: %+v", got)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || c.Outcome != store.TransactionNotCommitted || !revoked.Changed {
					t.Fatalf("revoke then accept: %+v %+v %v", revoked, c, err)
				}
				var count int
				if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM github_app_admins WHERE app_resource_id=$1 AND user_id=$2`, appID, joiner.UserID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("rejected accept inserted membership: %d %v", count, err)
				}
			}
			var consumed, revokedAt *time.Time
			if err := db.Pool.QueryRow(t.Context(), `SELECT consumed_at,revoked_at FROM github_app_admin_invitations WHERE id=$1`, invite.Invitation.ID).Scan(&consumed, &revokedAt); err != nil || (consumed != nil) != acceptFirst || (revokedAt != nil) == acceptFirst {
				t.Fatalf("durable terminal state: consumed=%v revoked=%v err=%v", consumed, revokedAt, err)
			}
		})
	}
}

func TestAppAdminScopeSerializesIssuerRemovalAndAccept(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, acceptFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "remove issuer first", true: "accept first"}[acceptFirst], func(t *testing.T) {
			db, appID, issuer, remaining, joiner := appAdminScopeFixture(t)
			c, err := db.WriteGitHubAppAdmins(t.Context(), appID, func(w store.GitHubAppAdminWriter) error {
				_, err := w.AddAdmin(t.Context(), appID, remaining.UserID)
				return err
			})
			if err != nil || c.Outcome != store.TransactionCommitted {
				t.Fatal(err)
			}
			member := readAppAdminMembership(t, db, appID, issuer.UserID)
			invite := mintAppAdminInvitation(t, db, appID, issuer)
			accept := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				_, err := coregithub.AcceptAdminInvitation(ctx, w, joiner, invite.Secret)
				return err
			}
			remove := func(ctx context.Context, w store.GitHubAppAdminWriter) error {
				_, err := coregithub.RemoveAdmin(ctx, w, remaining, appID, issuer.UserID, member.Version)
				return err
			}
			first, second := remove, accept
			if acceptFirst {
				first, second = accept, remove
			}
			c, err = serializedAppAdminOperations(t, db, appID, first, second)
			if acceptFirst {
				if err != nil || c.Outcome != store.TransactionCommitted {
					t.Fatalf("accept first: %+v %v", c, err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || c.Outcome != store.TransactionNotCommitted {
					t.Fatalf("remove first: %+v %v", c, err)
				}
			}
			var issuerRows, joinerRows int
			if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FILTER(WHERE user_id=$2),count(*) FILTER(WHERE user_id=$3) FROM github_app_admins WHERE app_resource_id=$1`, appID, issuer.UserID, joiner.UserID).Scan(&issuerRows, &joinerRows); err != nil || issuerRows != 0 || joinerRows != map[bool]int{false: 0, true: 1}[acceptFirst] {
				t.Fatalf("durable members: issuer=%d joiner=%d err=%v", issuerRows, joinerRows, err)
			}
		})
	}
}

func TestAppAdminScopeLastAdminAndRejoinCannotRestoreOldInvite(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, appID, first, second, joiner := appAdminScopeFixture(t)
	ctx := t.Context()
	c, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error { _, err := w.AddAdmin(ctx, appID, second.UserID); return err })
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatal(err)
	}
	firstBefore, secondBefore := readAppAdminMembership(t, db, appID, first.UserID), readAppAdminMembership(t, db, appID, second.UserID)
	oldInvite := mintAppAdminInvitation(t, db, appID, first)
	var removal coregithub.AdminRemoval
	c, err = serializedAppAdminOperations(t, db, appID, func(ctx context.Context, w store.GitHubAppAdminWriter) error {
		var err error
		removal, err = coregithub.RemoveAdmin(ctx, w, first, appID, first.UserID, firstBefore.Version)
		return err
	}, func(ctx context.Context, w store.GitHubAppAdminWriter) error {
		_, err := coregithub.RemoveAdmin(ctx, w, second, appID, second.UserID, secondBefore.Version)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "last_admin" || c.Outcome != store.TransactionNotCommitted || !removal.Removed || removal.ActorIsAdmin {
		t.Fatalf("last administrator: %+v %+v %v", removal, c, err)
	}
	freshInvite := mintAppAdminInvitation(t, db, appID, second)
	c, err = db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		_, err := coregithub.AcceptAdminInvitation(ctx, w, first, freshInvite.Secret)
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("rejoin: %+v %v", c, err)
	}
	if current := readAppAdminMembership(t, db, appID, first.UserID); current.Version <= firstBefore.Version {
		t.Fatalf("rejoin reused membership version: %+v", current)
	}
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		_, err := coregithub.InspectAdminInvitation(ctx, r, joiner, oldInvite.Secret)
		return err
	}); !errors.As(err, &fault) || fault.Code != "invitation_unavailable" {
		t.Fatalf("rejoined issuer inspect: %v", err)
	}
	c, err = db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		_, err := coregithub.AcceptAdminInvitation(ctx, w, joiner, oldInvite.Secret)
		return err
	})
	if !errors.As(err, &fault) || fault.Code != "invitation_unavailable" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rejoined issuer accept: %+v %v", c, err)
	}
	c, err = db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		_, err := coregithub.RemoveAdmin(ctx, w, second, appID, first.UserID, firstBefore.Version)
		return err
	})
	if !errors.As(err, &fault) || fault.Code != "version_conflict" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old membership deletion: %+v %v", c, err)
	}
}

func TestAppAdminScopeRollbackCancellationAndMissingApp(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, appID, issuer, joiner, _ := appAdminScopeFixture(t)
	ctx := t.Context()
	refused := errors.New("abort after mutation")
	c, err := db.WriteGitHubAppAdmins(ctx, appID, func(w store.GitHubAppAdminWriter) error {
		if _, err := w.AddAdmin(ctx, appID, joiner.UserID); err != nil {
			return err
		}
		return refused
	})
	if !errors.Is(err, refused) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("callback refusal: %+v %v", c, err)
	}
	if err := db.ReadGitHubAppAdmins(ctx, func(r store.GitHubAppAdminReader) error {
		_, err := r.Membership(ctx, appID, joiner.UserID)
		return err
	}); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("rolled-back membership persisted: %v", err)
	}
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err := holder.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, appID); err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(ctx)
	var called atomic.Bool
	done := make(chan error, 1)
	defer cancel()
	go func() {
		_, err := db.WriteGitHubAppAdmins(waiting, appID, func(store.GitHubAppAdminWriter) error { called.Store(true); return nil })
		done <- err
	}()
	waitForQueryLock(t, db, "SELECT id::text FROM github_apps WHERE")
	cancel()
	bounded, finish := context.WithTimeout(context.Background(), 5*time.Second)
	defer finish()
	if err := receiveQueryResult(t, bounded, done); !errors.Is(err, context.Canceled) || called.Load() {
		t.Fatalf("cancelled lock callback: called=%v err=%v", called.Load(), err)
	}
	if err := holder.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readAppAdminMembership(t, db, appID, issuer.UserID); got.UserID != issuer.UserID {
		t.Fatal(got)
	}
	for _, id := range []string{uuid.NewString(), appID} {
		if id == appID {
			mustQueryExec(t, db, `UPDATE github_apps SET deleted_at=now(),private_key_pem=NULL,webhook_secret=NULL WHERE id=$1`, appID)
		}
		called := false
		c, err := db.WriteGitHubAppAdmins(ctx, id, func(store.GitHubAppAdminWriter) error { called = true; return nil })
		if called || !errors.Is(err, model.ErrNotFound) || c.Outcome != store.TransactionNotCommitted {
			t.Fatalf("missing/deleted App: called=%v %+v %v", called, c, err)
		}
	}
	closed := closedStore(t)
	if _, err := closed.WriteGitHubAppAdmins(ctx, appID, func(store.GitHubAppAdminWriter) error { t.Fatal("closed pool callback"); return nil }); err == nil {
		t.Fatal("closed write pool accepted")
	}
	if err := closed.ReadGitHubAppAdmins(ctx, func(store.GitHubAppAdminReader) error { t.Fatal("closed pool callback"); return nil }); err == nil {
		t.Fatal("closed read pool accepted")
	}
}

func TestAppConfigScopeMissingRootAndClosedPool(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	app := uuid.NewString()
	ctx := t.Context()
	called := false
	c, err := db.WriteGitHubAppConfig(ctx, app, func(store.GitHubAppConfigWriter) error { called = true; return nil })
	if called || !errors.Is(err, model.ErrNotFound) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("missing root: %+v %v called=%v", c, err, called)
	}
	c, err = closedStore(t).WriteGitHubAppConfig(ctx, app, func(store.GitHubAppConfigWriter) error { t.Fatal("closed pool callback"); return nil })
	if err == nil || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("closed pool: %+v %v", c, err)
	}
}

func TestGitHubGrantLostCommitReceipt(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := t.Context()
	actor, app, teamID, grant, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'team')`, teamID)
	mustQueryExec(t, s, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret,impact_version) VALUES($1,1,'app','remote','slug','k','s',2)`, app)
	mustQueryExec(t, s, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, app, actor)
	mustQueryExec(t, s, `INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, grant, teamID, app)
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,app_resource_id,team_grant_id,enabled,sync_enabled,repository_id,legacy_repository_id,repository_full_name) VALUES($1,$2,$3,true,true,42,42,'owner/repo')`, project, app, grant)
	mustQueryExec(t, s, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,42,'owner/repo')`, project)
	mustQueryExec(t, s, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,42,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
	var armed, lost atomic.Bool
	config := s.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	p := model.Principal{UserID: actor, CredentialID: uuid.NewString(), Kind: model.SessionCredential}
	armed.Store(true)
	completion, err := (&Store{Pool: pool}).WriteGitHubGrant(ctx, teamID, app, actor, func(w store.GitHubGrantWriteDAO) error {
		return coregithub.RevokeGrant(ctx, w, p, grant, coregithub.RevokeGrantInput{ExpectedUserID: actor, Version: 1, ImpactVersion: 2})
	})
	var failure *store.TransactionError
	if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || failure.Phase != "commit" || !failure.CommitAttempted {
		t.Fatalf("receipt loss: %v %+v %+v %v", lost.Load(), completion, failure, err)
	}
	var stopped, revoked bool
	var count int
	var impact int64
	if err = s.Pool.QueryRow(ctx, `SELECT NOT enabled AND NOT sync_enabled AND app_resource_id IS NULL AND team_grant_id IS NULL AND repository_id=42,(SELECT revoked_at IS NOT NULL FROM github_app_team_grants WHERE id=$2),(SELECT impact_version FROM github_apps WHERE id=$3),(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project, grant, app).Scan(&stopped, &revoked, &impact, &count); err != nil || !stopped || !revoked || impact != 3 || count != 1 {
		t.Fatalf("durable result: stopped=%v revoked=%v impact=%d prs=%d err=%v", stopped, revoked, impact, count, err)
	}
}

type appLifecycleFixture struct {
	db         *Store
	actor      model.Principal
	project    model.Project
	app, grant string
}

func lifecycleFixture(t *testing.T, db *Store, appID int64) appLifecycleFixture {
	t.Helper()
	_, actor, _ := testAuthRecords(t, db)
	projectID := uuid.NewString()
	project, err := db.CreatePrivateProject(t.Context(), actor, projectID, "Private project", "https://example.com/"+projectID)
	if err != nil {
		t.Fatal(err)
	}
	f := appLifecycleFixture{db: db, actor: actor, project: project, app: uuid.NewString(), grant: uuid.NewString()}
	mustQueryExec(t, db, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,$2,'App','App','app','key','secret')`, f.app, appID)
	mustQueryExec(t, db, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, f.app, actor.UserID)
	mustQueryExec(t, db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, f.grant, f.app, project.Ownership.TeamID)
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,legacy_repository_id,repository_full_name,app_resource_id,team_grant_id,credential_version,claim_token,claim_until,claim_kind,next_poll_at) VALUES($1,2,3,4,true,true,$5,9,10,10,'owner/repo',$2,$3,1,$4,now()+interval '1 hour','poll',now())`, project.ID, f.app, f.grant, uuid.NewString(), appID)
	mustQueryExec(t, db, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,10,'owner/repo')`, project.ID)
	mustQueryExec(t, db, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,3,$2,'delivery',now(),now())`, project.ID, uuid.NewString())
	mustQueryExec(t, db, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,10,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project.ID)
	return f
}
func (f appLifecycleFixture) transfer(t *testing.T, target model.Team) (coreproject.TransferReceipt, error) {
	t.Helper()
	return projectservice.NewAppProjects(f.db).Transfer(t.Context(), f.actor, f.project.ID, coreproject.TransferInput{Ownership: f.project.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: target.Version}, ExpectedUserID: f.actor.UserID})
}
func (f appLifecycleFixture) target(t *testing.T) model.Team {
	t.Helper()
	team, err := testCreateTeam(f.db, t.Context(), f.actor.UserID, uuid.NewString(), "Target")
	if err != nil {
		t.Fatal(err)
	}
	return team
}
func (f appLifecycleFixture) assertStopped(t *testing.T, impact int64) {
	t.Helper()
	var stopped bool
	var gotImpact, pending, prs int64
	err := f.db.Pool.QueryRow(t.Context(), `SELECT NOT enabled AND NOT sync_enabled AND app_resource_id IS NULL AND team_grant_id IS NULL AND credential_version IS NULL AND app_id IS NULL AND installation_id IS NULL AND repository_id=10 AND repository_full_name='owner/repo' AND claim_token IS NULL AND next_poll_at IS NULL,(SELECT impact_version FROM github_apps WHERE id=$2),(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1),(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project.ID, f.app).Scan(&stopped, &gotImpact, &pending, &prs)
	if err != nil || !stopped || gotImpact != impact || pending != 0 || prs != 1 {
		t.Fatalf("retirement stopped=%t impact=%d pending=%d PRs=%d: %v", stopped, gotImpact, pending, prs, err)
	}
}

func TestAppProjectTransferStopsEvenWithSameAppDestination(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t, isolatedStore(t), 91)
	target := f.target(t)
	mustQueryExec(t, f.db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, uuid.NewString(), f.app, target.ID)
	invite := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO project_invitations(id,project_id,created_by,token_hash,created_at,expires_at) VALUES($1,$2,$3,sha256('lifecycle'::bytea),now(),now()+interval '1 day')`, invite, f.project.ID, f.actor.UserID)
	var grantsBefore int
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_grants WHERE project_id=$1`, f.project.ID).Scan(&grantsBefore); err != nil {
		t.Fatal(err)
	}
	receipt, err := f.transfer(t, target)
	if err != nil || !receipt.Changed || receipt.Ownership.TeamID != target.ID {
		t.Fatalf("transfer %+v %v", receipt, err)
	}
	f.assertStopped(t, 2)
	var retained bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1)=$3 AND EXISTS(SELECT 1 FROM project_invitations WHERE id=$2)`, f.project.ID, invite, grantsBefore).Scan(&retained); err != nil || !retained {
		t.Fatalf("Project grants/invitation retention %t %v", retained, err)
	}
}

func TestAppProjectSameTeamPreservesConnectionAndIntent(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t, isolatedStore(t), 91)
	var target model.Team
	err := f.db.ReadSnapshot(t.Context(), func(s store.SnapshotScope) error {
		var err error
		target, err = s.TeamDAO().Team(t.Context(), f.actor.UserID, f.project.Ownership.TeamID)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	r, err := f.transfer(t, target)
	if err != nil || r.Changed {
		t.Fatalf("same Team %+v %v", r, err)
	}
	var unchanged bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT enabled AND sync_enabled AND app_resource_id=$2 AND version=2 AND generation=3 AND (SELECT impact_version=1 FROM github_apps WHERE id=$2) FROM project_github WHERE project_id=$1`, f.project.ID, f.app).Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("same Team changed binding %t %v", unchanged, err)
	}
}

func TestAppProjectDeletionStopsAndRetainsHistoricalData(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t, isolatedStore(t), 91)
	task, sessionID := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,title,status,deleted_at) VALUES($1,$2,'Historical task','done',now())`, task, f.project.ID)
	mustQueryExec(t, f.db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,connection_expires_at) VALUES($1,$2,$3,$4,$5,$6,'{}','{"lifecycle":"active","controls":{"x":1}}','active-grant',now()+interval '1 hour',now()+interval '1 hour')`, sessionID, f.project.ID, task, uuid.NewString(), f.actor.UserID, uuid.NewString())
	mustQueryExec(t, f.db, `INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{"kind":"history"}')`, sessionID)
	r, err := projectservice.NewAppProjects(f.db).Delete(t.Context(), f.actor, f.project.ID)
	if err != nil || !r.Deleted {
		t.Fatalf("delete %+v %v", r, err)
	}
	f.assertStopped(t, 2)
	var deleted, granted bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT deleted_at IS NOT NULL,EXISTS(SELECT 1 FROM project_grants WHERE project_id=$1) FROM projects WHERE id=$1`, f.project.ID).Scan(&deleted, &granted); err != nil || !deleted || !granted {
		t.Fatalf("deleted=%t historical grant=%t: %v", deleted, granted, err)
	}
	var retired, fencedOnce bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT snapshot->>'lifecycle'='draining' AND snapshot->'controls' IS NULL AND grant_hash IS NULL AND grant_expires_at IS NULL AND connection_expires_at IS NULL AND (SELECT count(*)=1 FROM session_events WHERE session_id=$1), (SELECT version=3 AND generation=4 AND revision=5 FROM project_github WHERE project_id=$2) FROM task_sessions WHERE id=$1`, sessionID, f.project.ID).Scan(&retired, &fencedOnce); err != nil || !retired || !fencedOnce {
		t.Fatalf("Session retirement=%t single connection fence=%t: %v", retired, fencedOnce, err)
	}
}

func TestAppProjectDeletionStorageFailureRollsBackRetirement(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t, isolatedStore(t), 91)
	mustQueryExec(t, f.db, `CREATE FUNCTION reject_app_project_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected Project deletion failure'; END $$; CREATE TRIGGER reject_app_project_deletion BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION reject_app_project_deletion()`)
	_, err := projectservice.NewAppProjects(f.db).Delete(t.Context(), f.actor, f.project.ID)
	var failure *projectservice.DeletionFailure
	if !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted {
		t.Fatalf("storage failure lost completion: %v", err)
	}
	var intact bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT p.deleted_at IS NULL AND c.enabled AND c.sync_enabled AND c.version=2 AND c.generation=3 AND c.app_resource_id=$2 AND (SELECT impact_version=1 FROM github_apps WHERE id=$2) AND EXISTS(SELECT 1 FROM project_github_pending_prs WHERE project_id=$1) FROM projects p JOIN project_github c ON c.project_id=p.id WHERE p.id=$1`, f.project.ID, f.app).Scan(&intact); err != nil || !intact {
		t.Fatalf("retirement escaped rollback=%t: %v", !intact, err)
	}
}

func TestAppProjectDeletionRejectsMissingOwnershipRoots(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	for index, missing := range []string{"ownership", "Team"} {
		t.Run(missing, func(t *testing.T) {
			f := lifecycleFixture(t, db, 91+int64(index))
			if missing == "ownership" {
				mustQueryExec(t, f.db, `DELETE FROM project_ownership WHERE project_id=$1`, f.project.ID)
			} else {
				mustQueryExec(t, f.db, `DELETE FROM teams WHERE id=$1`, f.project.Ownership.TeamID)
			}
			called := false
			c, err := f.db.WriteGitHubProjectDeletion(t.Context(), f.project.ID, func(store.GitHubProjectDeletionScope) error { called = true; return nil })
			if called || err == nil || c.Outcome != store.TransactionNotCommitted {
				t.Fatalf("missing ownership root entered deletion: called=%t %+v %v", called, c, err)
			}
		})
	}
}

func TestAppProjectRetirementRollbackAndUnboundIntent(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t, isolatedStore(t), 91)
	sentinel := errors.New("rollback retirement")
	c, err := f.db.WriteGitHubProjectTransfer(t.Context(), f.project.ID, func(s store.GitHubProjectTransferScope) error {
		d := s.GitHubDAO()
		if _, err := d.LockBinding(t.Context()); err != nil {
			return err
		}
		if err := d.Stop(t.Context(), coregithub.DisconnectionDecision()); err != nil {
			return err
		}
		if err := d.AdvanceImpact(t.Context()); err != nil {
			return err
		}
		return sentinel
	})
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("rollback %+v %v", c, err)
	}
	var retained bool
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT enabled AND sync_enabled AND version=2 AND (SELECT impact_version=1 FROM github_apps WHERE id=$2) FROM project_github WHERE project_id=$1`, f.project.ID, f.app).Scan(&retained); err != nil || !retained {
		t.Fatalf("rollback persistence %t %v", retained, err)
	}
	mustQueryExec(t, f.db, `UPDATE project_github SET enabled=false,app_resource_id=NULL,team_grant_id=NULL,credential_version=NULL,app_id=NULL,installation_id=NULL WHERE project_id=$1`, f.project.ID)
	if _, err = f.transfer(t, f.target(t)); err != nil {
		t.Fatal(err)
	}
	f.assertStopped(t, 1)
}

func TestAppLifecycleWaitsForAppDeletionAndReadsCleanup(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	for index, operation := range []string{"transfer", "project-delete", "team-delete"} {
		t.Run(operation, func(t *testing.T) {
			f := lifecycleFixture(t, db, 91+int64(index))
			target := f.target(t)
			if operation == "team-delete" {
				mustQueryExec(t, f.db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, uuid.NewString(), f.app, target.ID)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			tx, err := f.db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			var id string
			if err = tx.QueryRow(ctx, `SELECT id::text FROM github_apps WHERE id=$1 FOR UPDATE`, f.app).Scan(&id); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				var operationError error
				switch operation {
				case "transfer":
					_, operationError = projectservice.NewAppProjects(f.db).Transfer(ctx, f.actor, f.project.ID, coreproject.TransferInput{Ownership: f.project.Ownership, TargetTeam: coreproject.TeamVersion{ID: target.ID, Version: target.Version}, ExpectedUserID: f.actor.UserID})
				case "project-delete":
					_, operationError = projectservice.NewAppProjects(f.db).Delete(ctx, f.actor, f.project.ID)
				case "team-delete":
					operationError = teamservice.NewAppTeams(f.db).Delete(ctx, f.actor, target.ID, coreteam.ChangeTeam{Name: *target.Name, Version: target.Version, ExpectedUserID: f.actor.UserID})
				}
				result <- operationError
			}()
			prefix := "SELECT deleted_at IS NOT NULL FROM github_apps"
			if operation == "team-delete" {
				prefix = "SELECT id::text FROM github_apps"
			}
			testutil.WaitTransferTeamLock(t, ctx, f.db.Pool, prefix, tx.Conn().PgConn().PID())
			if err = coregithub.RemoveApp(ctx, githubdao.NewAppConfigWriter(tx, f.app), f.actor, coregithub.RemoveAppInput{Version: 1, ImpactVersion: 1, ExpectedUserID: f.actor.UserID}); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			f.assertStopped(t, 2)
		})
	}
}

func TestAppTeamDeletionRetiresOnlyItsGrants(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := lifecycleFixture(t, isolatedStore(t), 91)
	target := f.target(t)
	grant := uuid.NewString()
	mustQueryExec(t, f.db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, grant, f.app, target.ID)
	err := teamservice.NewAppTeams(f.db).Delete(t.Context(), f.actor, target.ID, coreteam.ChangeTeam{Name: *target.Name, Version: target.Version, ExpectedUserID: f.actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	var correct bool
	err = f.db.Pool.QueryRow(t.Context(), `SELECT NOT EXISTS(SELECT 1 FROM teams WHERE id=$1) AND EXISTS(SELECT 1 FROM github_app_team_grants WHERE id=$2 AND revoked_at IS NOT NULL) AND EXISTS(SELECT 1 FROM github_app_team_grants WHERE id=$3 AND revoked_at IS NULL) AND EXISTS(SELECT 1 FROM github_app_admins WHERE app_resource_id=$4) AND EXISTS(SELECT 1 FROM github_apps WHERE id=$4 AND deleted_at IS NULL AND impact_version=2) AND EXISTS(SELECT 1 FROM project_github WHERE project_id=$5 AND enabled AND sync_enabled)`, target.ID, grant, f.grant, f.app, f.project.ID).Scan(&correct)
	if err != nil || !correct {
		t.Fatalf("Team retirement preservation=%t %v", correct, err)
	}
}

func TestAppLifecycleScopeMissingRootsAndClosedPool(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, fixture := range []struct {
		name string
		db   *Store
	}{
		{"missing root", isolatedStore(t)},
		{"closed pool", closedStore(t)},
	} {
		for _, kind := range []string{"transfer", "delete", "team"} {
			t.Run(fixture.name+"/"+kind, func(t *testing.T) {
				called := false
				var c store.Completion
				var err error
				switch kind {
				case "transfer":
					c, err = fixture.db.WriteGitHubProjectTransfer(t.Context(), uuid.NewString(), func(store.GitHubProjectTransferScope) error { called = true; return nil })
				case "delete":
					c, err = fixture.db.WriteGitHubProjectDeletion(t.Context(), uuid.NewString(), func(store.GitHubProjectDeletionScope) error { called = true; return nil })
				case "team":
					c, err = fixture.db.WriteGitHubTeamDeletion(t.Context(), uuid.NewString(), func(store.GitHubTeamDeletionScope) error { called = true; return nil })
				}
				if called || err == nil || c.Outcome != store.TransactionNotCommitted {
					t.Fatalf("missing/closed callback=%t %+v %v", called, c, err)
				}
			})
		}
	}
}
