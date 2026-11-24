package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func projectAppScopeFixture(t *testing.T) (*Store, string, string, string, string, string) {
	t.Helper()
	s := isolatedStore(t)
	actor, project, team, app, grant := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::text,now(),now())`, actor)
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'team')`, team)
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, actor)
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'project','https://github.com/o/r')`, project)
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team)
	mustQueryExec(t, s, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,9,'app','remote','slug','k','s')`, app)
	mustQueryExec(t, s, `INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, grant, team, app)
	return s, actor, project, team, app, grant
}

func TestProjectAppScopeLostCommitReceipt(t *testing.T) {
	parallelRootDatabaseTest(t)
	s, actor, project, _, app, grant := projectAppScopeFixture(t)
	ctx := t.Context()
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
	p := model.Principal{Kind: model.SessionCredential, UserID: actor, CredentialID: uuid.NewString()}
	in := core.ProjectAppConnect{ProjectAppSelection: core.ProjectAppSelection{AppResourceID: app, GrantID: grant, AppVersion: 1, OwnershipVersion: 1}, Version: 1, InstallationID: 7, RepositoryVersion: 1}
	proof := core.InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 7, AccountLogin: "o"}, Repository: githubpr.RepositoryObservation{ID: 8, FullName: "o/r"}}
	armed.Store(true)
	c, err := (&Store{Pool: pool}).WriteGitHubProjectApp(ctx, project, actor, app, func(d store.GitHubProjectAppWriteDAO) error {
		_, e := core.ManageProjectApp(ctx, d, p, "connect", in, 0, false, "https://github.com/o/r", proof)
		return e
	})
	var txError *store.TransactionError
	if !lost.Load() || c.Outcome != store.TransactionUnknown || !errors.As(err, &txError) || txError.Phase != "commit" {
		t.Fatalf("lost receipt: %+v %v", c, err)
	}
	var durable bool
	if err = s.Pool.QueryRow(ctx, `SELECT enabled AND app_resource_id=$2 AND team_grant_id=$3 AND repository_id=8 AND version=2 AND (SELECT impact_version=2 FROM github_apps WHERE id=$2) FROM project_github WHERE project_id=$1`, project, app, grant).Scan(&durable); err != nil || !durable {
		t.Fatalf("durable original: %v %v", durable, err)
	}
}

type projectAppRootState struct {
	ownership, team, app, grant           string
	connectionTable, appTable, grantTable uint32
	appColumn                             int16
}

func readProjectAppRootState(t *testing.T, ctx context.Context, s *Store, project, team, app, grant string) projectAppRootState {
	t.Helper()
	var state projectAppRootState
	var intact bool
	err := s.Pool.QueryRow(ctx, `SELECT
 (SELECT to_jsonb(o)::text FROM project_ownership o WHERE project_id=$1),
 (SELECT to_jsonb(t)::text FROM teams t WHERE id=$2),
 (SELECT to_jsonb(a)::text FROM github_apps a WHERE id=$3),
 (SELECT to_jsonb(g)::text FROM github_app_team_grants g WHERE id=$4),
 'project_github'::regclass::oid,
 'github_apps'::regclass::oid,
 'github_app_team_grants'::regclass::oid,
 (SELECT attnum FROM pg_attribute WHERE attrelid='project_github'::regclass AND attname='app_resource_id' AND NOT attisdropped),
 NOT EXISTS(SELECT FROM project_github WHERE project_id=$1)
   AND to_regclass('broken_apps') IS NULL
   AND to_regclass('broken_grants') IS NULL
   AND NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid='project_github'::regclass AND attname='broken_app' AND NOT attisdropped)`, project, team, app, grant).
		Scan(&state.ownership, &state.team, &state.app, &state.grant, &state.connectionTable, &state.appTable, &state.grantTable, &state.appColumn, &intact)
	if err != nil || !intact {
		t.Fatalf("Project App root fixture is not intact: %v, %v", intact, err)
	}
	return state
}

func TestProjectAppScopeMissingAndFailedRoots(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, actorID, projectID, teamID, appResourceID, grantID := projectAppScopeFixture(t)
	before := readProjectAppRootState(t, t.Context(), db, projectID, teamID, appResourceID, grantID)
	for _, test := range []struct {
		name, phase, state    string
		breakSQL, repairSQL   string
		breakArgs, repairArgs []any
	}{
		{
			name: "ownership", phase: "lock App ownership",
			breakSQL:  `DELETE FROM project_ownership WHERE project_id=$1`,
			repairSQL: `INSERT INTO project_ownership SELECT * FROM jsonb_populate_record(NULL::project_ownership,$1::jsonb)`,
			breakArgs: []any{projectID}, repairArgs: []any{before.ownership},
		},
		{
			name: "owner Team", phase: "lock App owner Team",
			breakSQL:  `DELETE FROM teams WHERE id=$1`,
			repairSQL: `INSERT INTO teams SELECT * FROM jsonb_populate_record(NULL::teams,$1::jsonb)`,
			breakArgs: []any{teamID}, repairArgs: []any{before.team},
		},
		{
			name: "candidate query", phase: "read candidate App binding", state: "42703",
			breakSQL:  `ALTER TABLE project_github RENAME COLUMN app_resource_id TO broken_app`,
			repairSQL: `ALTER TABLE project_github RENAME COLUMN broken_app TO app_resource_id`,
		},
		{
			name: "App query", phase: "lock project App", state: "42P01",
			breakSQL:  `ALTER TABLE github_apps RENAME TO broken_apps`,
			repairSQL: `ALTER TABLE broken_apps RENAME TO github_apps`,
		},
		{
			name: "grant query", phase: "lock project App grants", state: "42P01",
			breakSQL:  `ALTER TABLE github_app_team_grants RENAME TO broken_grants`,
			repairSQL: `ALTER TABLE broken_grants RENAME TO github_app_team_grants`,
		},
	} {
		if !t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			if tag, err := db.Pool.Exec(ctx, test.breakSQL, test.breakArgs...); err != nil || (len(test.breakArgs) != 0 && tag.RowsAffected() != 1) {
				t.Fatalf("install Project App root fault: %v, %v", tag, err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if tag, err := db.Pool.Exec(ctx, test.repairSQL, test.repairArgs...); err != nil || (len(test.repairArgs) != 0 && tag.RowsAffected() != 1) {
					t.Fatalf("restore Project App root: %v, %v", tag, err)
				}
				db.Pool.Reset()
				calls := 0
				completion, err := db.WriteGitHubProjectApp(ctx, projectID, actorID, appResourceID, func(store.GitHubProjectAppWriteDAO) error { calls++; return nil })
				if err != nil || completion.Outcome != store.TransactionCommitted || calls != 1 {
					t.Fatalf("restored Project App root: completion=%+v calls=%d error=%v", completion, calls, err)
				}
				if got := readProjectAppRootState(t, ctx, db, projectID, teamID, appResourceID, grantID); got != before {
					t.Fatal("Project App root fault changed committed rows or catalog identities")
				}
			})
			db.Pool.Reset()
			calls := 0
			completion, err := db.WriteGitHubProjectApp(ctx, projectID, actorID, appResourceID, func(store.GitHubProjectAppWriteDAO) error { calls++; return nil })
			var failure *store.TransactionError
			var cause *store.Error
			if completion.Outcome != store.TransactionNotCommitted || calls != 0 ||
				!errors.As(err, &failure) || !errors.As(failure.Cause, &cause) || cause.Phase != test.phase {
				t.Fatalf("failed Project App root: completion=%+v calls=%d error=%v, want phase %s", completion, calls, err, test.phase)
			}
			if test.state == "" {
				if !cause.MissingRow || cause.DatabaseFailure || !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("missing Project App root error lost: %v", err)
				}
			} else {
				var pg *pgconn.PgError
				if !cause.DatabaseFailure || !errors.As(err, &pg) || pg.Code != test.state {
					t.Fatalf("Project App root error = %v, want SQLSTATE %s", err, test.state)
				}
			}
		}) {
			return
		}
	}

	missing := uuid.NewString()
	if _, err := db.WriteGitHubProjectApp(t.Context(), projectID, actorID, missing, func(store.GitHubProjectAppWriteDAO) error { return nil }); err != nil {
		t.Fatalf("missing unbound App should be checked by core: %v", err)
	}
	mustQueryExec(t, db, `INSERT INTO project_github(project_id,app_resource_id) VALUES($1,$2)`, projectID, missing)
	if _, err := db.WriteGitHubProjectApp(t.Context(), projectID, actorID, appResourceID, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("inconsistent callback"); return nil }); err == nil {
		t.Fatal("missing referenced App hidden")
	}
	if _, err := closedStore(t).WriteGitHubProjectApp(t.Context(), projectID, actorID, appResourceID, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("closed callback"); return nil }); err == nil {
		t.Fatal("closed pool")
	}
}

func TestGitHubResourcesShareProjectSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	ctx := t.Context()
	mustQueryExec(t, database, `INSERT INTO project_github(project_id,version,revision,repository_id,legacy_repository_id,repository_full_name) VALUES($1,2,1,10,10,'owner/repo')`, project.ID)
	mustQueryExec(t, database, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,10,'owner/repo')`, project.ID)
	mustQueryExec(t, database, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,10,1,1,'url','first','open',false,'main','sha',now(),now(),now(),1)`, project.ID)
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if _, err := scope.ProjectDAO().Project(ctx, project.ID); err != nil {
			return err
		}
		before, err := scope.GitHubDAO().Connection(ctx, project.ID)
		if err != nil {
			return err
		}
		mustQueryExec(t, database, `UPDATE project_github SET revision=2 WHERE project_id=$1`, project.ID)
		mustQueryExec(t, database, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,10,2,2,'url','second','open',false,'main','sha',now(),now(),now(),2)`, project.ID)
		counts, err := scope.GitHubDAO().PullRequestCounts(ctx, store.GitHubPRCountsQuery{ProjectID: project.ID})
		if err != nil {
			return err
		}
		page, err := scope.GitHubDAO().PullRequests(ctx, store.GitHubPRQuery{ProjectID: project.ID, State: "all", Limit: 10})
		if err != nil {
			return err
		}
		if before.Revision != 1 || counts.All != 1 || page.Total != 1 || len(page.Items) != 1 || page.Items[0].Number != 1 {
			return fmt.Errorf("mixed snapshot: connection=%+v counts=%+v page=%+v", before, counts, page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		c, err := scope.GitHubDAO().Connection(ctx, project.ID)
		if err != nil {
			return err
		}
		counts, err := scope.GitHubDAO().PullRequestCounts(ctx, store.GitHubPRCountsQuery{ProjectID: project.ID})
		if err != nil {
			return err
		}
		if c.Revision != 2 || counts.All != 2 {
			return fmt.Errorf("fresh snapshot missed write: %+v %+v", c, counts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubConfigurationSharesProjectTransaction(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, actor, project, team, app, grant := projectAppScopeFixture(t)
	ctx := t.Context()
	principal := model.Principal{Kind: model.SessionCredential, UserID: actor, CredentialID: uuid.NewString()}
	appID, installationID, repositoryID, credential := int64(9), int64(7), int64(8), int64(1)
	account, fullName := "o", "o/r"
	write := store.GitHubProjectAppWrite{Configuration: store.GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, Generation: 1, Revision: 1, Enabled: true, AppID: &appID, InstallationID: &installationID, RepositoryID: &repositoryID, InstallationAccountLogin: &account, RepositoryFullName: &fullName, PollIntervalMinutes: 5, AccessState: "available"}, AppResourceID: &app, GrantID: &grant, CredentialVersion: &credential}
	rollback := errors.New("abort transaction")
	apply := func(abort bool) (store.Completion, error) {
		return database.WriteGitHubProjectApp(ctx, project, actor, app, func(dao store.GitHubProjectAppWriteDAO) error {
			facts, err := dao.Facts(ctx, principal)
			if err != nil {
				return err
			}
			if facts.Project.ID != project || facts.Project.Ownership.TeamID != team || facts.Connection.Version != 1 || facts.AppResourceID != nil {
				return fmt.Errorf("initial facts: %+v", facts)
			}
			selected, err := dao.App(ctx, app, grant, team)
			if err != nil {
				return err
			}
			if selected.ID != app || selected.CredentialVersion != credential {
				return fmt.Errorf("selected App: %+v", selected)
			}
			ok, err := dao.Save(ctx, write)
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("configuration not written")
			}
			if abort {
				return rollback
			}
			return nil
		})
	}
	completion, err := apply(true)
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		c, err := scope.GitHubDAO().Connection(ctx, project)
		if err != nil {
			return err
		}
		if c.Version != 1 || c.Generation != 0 || c.Revision != 0 || c.Enabled || c.PollIntervalMinutes != 5 || c.AccessState != "unknown" || c.CreatedAt != nil {
			return fmt.Errorf("virtual default after rollback: %+v", c)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completion, err = apply(false)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("commit: %+v %v", completion, err)
	}
	if err := database.ReadGitHubProjectApp(ctx, project, func(dao store.GitHubProjectAppReadDAO) error {
		facts, err := dao.Facts(ctx, principal)
		if err != nil {
			return err
		}
		if facts.Connection.Version != 2 || facts.Connection.CreatedAt == nil || !facts.Connection.Enabled || facts.AppResourceID == nil || *facts.AppResourceID != app || facts.GrantID == nil || *facts.GrantID != grant || facts.CredentialVersion == nil || *facts.CredentialVersion != credential {
			return fmt.Errorf("committed facts: %+v", facts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	completion, err = database.WriteGitHubProjectApp(ctx, project, actor, app, func(dao store.GitHubProjectAppWriteDAO) error {
		ok, err := dao.Save(ctx, write)
		if err != nil {
			return err
		}
		if ok {
			return errors.New("stale configuration accepted")
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("stale condition: %+v %v", completion, err)
	}
	bad := write
	bad.Configuration.ExpectedVersion, bad.Configuration.Version = 2, 3
	invalidCredential := credential + 1
	bad.CredentialVersion = &invalidCredential
	completion, err = database.WriteGitHubProjectApp(ctx, project, actor, app, func(dao store.GitHubProjectAppWriteDAO) error {
		_, err := dao.Save(ctx, bad)
		return err
	})
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("invalid App binding: %+v %v", completion, err)
	}
	if err := database.ReadGitHubProjectApp(ctx, project, func(dao store.GitHubProjectAppReadDAO) error {
		facts, err := dao.Facts(ctx, principal)
		if err != nil {
			return err
		}
		if facts.Connection.Version != 2 || facts.AppResourceID == nil || *facts.AppResourceID != app || facts.GrantID == nil || *facts.GrantID != grant || facts.CredentialVersion == nil || *facts.CredentialVersion != credential {
			return fmt.Errorf("failed write changed binding: %+v", facts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
