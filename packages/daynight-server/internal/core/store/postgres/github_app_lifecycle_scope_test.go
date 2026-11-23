package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/google/uuid"
)

type appLifecycleFixture struct {
	db         *Store
	actor      model.Principal
	project    model.Project
	app, grant string
}

func lifecycleFixture(t *testing.T) appLifecycleFixture {
	t.Helper()
	db, actor, _, project := membershipFixture(t)
	f := appLifecycleFixture{db: db, actor: actor, project: project, app: uuid.NewString(), grant: uuid.NewString()}
	mustQueryExec(t, db, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','App','app','key','secret')`, f.app)
	mustQueryExec(t, db, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, f.app, actor.UserID)
	mustQueryExec(t, db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, f.grant, f.app, project.Ownership.TeamID)
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_id,installation_id,repository_id,legacy_repository_id,repository_full_name,app_resource_id,team_grant_id,credential_version,claim_token,claim_until,claim_kind,next_poll_at) VALUES($1,2,3,4,true,true,91,9,10,10,'owner/repo',$2,$3,1,$4,now()+interval '1 hour','poll',now())`, project.ID, f.app, f.grant, uuid.NewString())
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
	f := lifecycleFixture(t)
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
	f := lifecycleFixture(t)
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
	f := lifecycleFixture(t)
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
	f := lifecycleFixture(t)
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
	for _, missing := range []string{"ownership", "Team"} {
		t.Run(missing, func(t *testing.T) {
			f := lifecycleFixture(t)
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
	f := lifecycleFixture(t)
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
	for _, operation := range []string{"transfer", "project-delete", "team-delete"} {
		t.Run(operation, func(t *testing.T) {
			f := lifecycleFixture(t)
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
			if err = coregithub.RemoveApp(ctx, github.NewAppConfigWriter(tx, f.app), f.actor, coregithub.RemoveAppInput{Version: 1, ImpactVersion: 1, ExpectedUserID: f.actor.UserID}); err != nil {
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
	f := lifecycleFixture(t)
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
	f := lifecycleFixture(t)
	for _, closed := range []bool{false, true} {
		if closed {
			f.db.Pool.Close()
		}
		for _, kind := range []string{"transfer", "delete", "team"} {
			t.Run(fmt.Sprintf("%s/closed=%t", kind, closed), func(t *testing.T) {
				called := false
				var c store.Completion
				var err error
				switch kind {
				case "transfer":
					c, err = f.db.WriteGitHubProjectTransfer(t.Context(), uuid.NewString(), func(store.GitHubProjectTransferScope) error { called = true; return nil })
				case "delete":
					c, err = f.db.WriteGitHubProjectDeletion(t.Context(), uuid.NewString(), func(store.GitHubProjectDeletionScope) error { called = true; return nil })
				case "team":
					c, err = f.db.WriteGitHubTeamDeletion(t.Context(), uuid.NewString(), func(store.GitHubTeamDeletionScope) error { called = true; return nil })
				}
				if called || err == nil || c.Outcome != store.TransactionNotCommitted {
					t.Fatalf("missing/closed callback=%t %+v %v", called, c, err)
				}
			})
		}
	}
}
