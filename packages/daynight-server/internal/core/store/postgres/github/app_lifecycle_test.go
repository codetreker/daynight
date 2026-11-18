package github_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectRetirementMissingUnboundAndIntegrity(t *testing.T) {
	db, _ := dbFixture(t)
	for index, kind := range []string{"no connection", "unbound", "missing App", "deleted App", "revoked grant", "missing grant", "orphan grant", "exhausted", "bound stop failure", "unbound stop failure"} {
		if !t.Run(kind, func(t *testing.T) {
			ctx := t.Context()
			appID := 91 + int64(index)
			app, grant, project, team := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,$2,'App','App','app','key','secret')`, app, appID); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, grant, app, team); err != nil {
				t.Fatal(err)
			}
			if kind != "no connection" {
				if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,app_resource_id,team_grant_id,credential_version,app_id,installation_id) VALUES($1,1,1,1,true,true,$2,$3,1,$4,9)`, project, app, grant, appID); err != nil {
					t.Fatal(err)
				}
			}
			var mutation string
			target := project
			switch kind {
			case "unbound", "unbound stop failure":
				mutation = `UPDATE project_github SET enabled=false,app_resource_id=NULL,team_grant_id=NULL,credential_version=NULL,app_id=NULL,installation_id=NULL WHERE project_id=$1`
			case "missing App":
				mutation, target = `DELETE FROM github_apps WHERE id=$1`, app
			case "deleted App":
				mutation, target = `UPDATE github_apps SET deleted_at=now() WHERE id=$1`, app
			case "revoked grant":
				mutation, target = `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, grant
			case "missing grant":
				mutation, target = `DELETE FROM github_app_team_grants WHERE id=$1`, grant
			case "orphan grant":
				mutation = `UPDATE project_github SET app_resource_id=NULL WHERE project_id=$1`
			case "exhausted":
				mutation = `UPDATE project_github SET generation=9223372036854775807 WHERE project_id=$1`
			}
			if mutation != "" {
				result, err := db.Pool.Exec(ctx, mutation, target)
				if err != nil || result.RowsAffected() != 1 {
					t.Fatalf("seed %s: %v %v", kind, result, err)
				}
			}
			stopFailure := strings.HasSuffix(kind, "stop failure")
			if stopFailure {
				if _, err := db.Pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,1,1,$2,'retirement',now(),now())`, project, uuid.NewString()); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_retirement_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected retirement update failure'; END $$; CREATE TRIGGER reject_retirement_update BEFORE UPDATE ON project_github FOR EACH ROW EXECUTE FUNCTION reject_retirement_update()`); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("release retirement transaction: %v", err)
				}
			}()
			dao := github.NewProjectRetirement(tx, project)
			if err = dao.Stop(ctx, core.DisconnectionDecision()); err == nil {
				t.Fatal("unlocked stop succeeded")
			}
			if err = dao.AdvanceImpact(ctx); err == nil {
				t.Fatal("unlocked impact succeeded")
			}
			_, err = dao.LockBinding(ctx)
			wantIntegrity := strings.Contains(kind, "App") || strings.Contains(kind, "grant")
			if wantIntegrity {
				if err == nil {
					t.Fatal("invalid binding accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			err = dao.Stop(ctx, core.DisconnectionDecision())
			if stopFailure {
				var pg *pgconn.PgError
				if !errors.As(err, &pg) || pg.Code != "P0001" || pg.Message != "injected retirement update failure" {
					t.Fatalf("retirement did not expose injected trigger failure: %v", err)
				}
				if err := tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				var intact bool
				if err := db.Pool.QueryRow(ctx, `SELECT sync_enabled AND version=1 AND generation=1 AND EXISTS(SELECT 1 FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project).Scan(&intact); err != nil || !intact {
					t.Fatalf("failed retirement escaped rollback=%t: %v", !intact, err)
				}
				if _, err := db.Pool.Exec(ctx, `DROP TRIGGER reject_retirement_update ON project_github; DROP FUNCTION reject_retirement_update()`); err != nil {
					t.Fatal(err)
				}
				var removed bool
				if err := db.Pool.QueryRow(ctx, `SELECT to_regprocedure('reject_retirement_update()') IS NULL AND NOT EXISTS
					(SELECT 1 FROM pg_trigger WHERE tgrelid='project_github'::regclass AND tgname='reject_retirement_update')`).Scan(&removed); err != nil || !removed {
					t.Fatalf("retirement trigger cleanup: removed=%t error=%v", removed, err)
				}
				return
			}
			if kind == "exhausted" {
				if err == nil {
					t.Fatal("exhausted counter accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if err = dao.AdvanceImpact(ctx); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if kind == "unbound" {
				var sync bool
				if err = db.Pool.QueryRow(ctx, `SELECT sync_enabled FROM project_github WHERE project_id=$1`, project).Scan(&sync); err != nil || sync {
					t.Fatalf("unbound intent=%t %v", sync, err)
				}
			}
		}) {
			return
		}
	}
}

func TestRetirementDAOPropagatesCancellation(t *testing.T) {
	for _, operation := range []string{"binding", "Team grants", "stop", "impact", "revoke"} {
		t.Run(operation, func(t *testing.T) {
			db, _ := dbFixture(t)
			ctx := t.Context()
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			canceled, cancel := context.WithCancel(ctx)
			cancel()
			switch operation {
			case "binding":
				_, err = github.NewProjectRetirement(tx, uuid.NewString()).LockBinding(canceled)
			case "Team grants":
				_, err = github.NewTeamRetirement(tx, uuid.NewString()).LockGrants(canceled)
			case "stop":
				err = github.NewTeamRetirement(tx, uuid.NewString()).StopGrant(canceled, retirementGrant(), core.DisconnectionDecision())
			case "impact":
				err = github.NewTeamRetirement(tx, uuid.NewString()).AdvanceImpact(canceled, retirementGrant())
			case "revoke":
				err = github.NewTeamRetirement(tx, uuid.NewString()).RevokeGrant(canceled, retirementGrant())
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation lost: %v", err)
			}
		})
	}
}

func TestTeamRetirementRejectsUnavailableLiveGrant(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "deleted"}[deleted], func(t *testing.T) {
			db, _ := dbFixture(t)
			ctx := t.Context()
			app, team := uuid.NewString(), uuid.NewString()
			if deleted {
				if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret,deleted_at) VALUES($1,91,'App','App','app','key','secret',now())`, app); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, uuid.NewString(), app, team); err != nil {
				t.Fatal(err)
			}
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err = github.NewTeamRetirement(tx, team).LockGrants(ctx); err == nil {
				t.Fatal("unavailable grant App accepted")
			}
		})
	}
}

func retirementGrant() store.GitHubTeamRetirementGrant {
	return store.GitHubTeamRetirementGrant{ID: uuid.NewString(), AppID: uuid.NewString()}
}
