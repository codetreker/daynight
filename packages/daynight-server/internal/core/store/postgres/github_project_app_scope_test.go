package postgres

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
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
	in := core.ProjectAppConnect{ProjectAppSelection: core.ProjectAppSelection{AppResourceID: app, GrantID: grant, AppVersion: 1, OwnershipVersion: 1}, Version: 1, InstallationID: 7}
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

func TestProjectAppScopeMissingAndFailedRoots(t *testing.T) {
	for _, tc := range []struct {
		name, breakSQL string
		args           func(string, string, string) []any
	}{
		{"ownership", `DELETE FROM project_ownership WHERE project_id=$1`, func(project, _, _ string) []any { return []any{project} }},
		{"owner Team", `DELETE FROM teams WHERE id=$1`, func(_, team, _ string) []any { return []any{team} }},
		{"candidate query", `ALTER TABLE project_github RENAME COLUMN app_resource_id TO broken_app`, func(string, string, string) []any { return nil }},
		{"App query", `ALTER TABLE github_apps RENAME TO broken_apps`, func(string, string, string) []any { return nil }},
		{"grant query", `ALTER TABLE github_app_team_grants RENAME TO broken_grants`, func(string, string, string) []any { return nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, actor, project, team, app, _ := projectAppScopeFixture(t)
			mustQueryExec(t, s, tc.breakSQL, tc.args(project, team, app)...)
			c, err := s.WriteGitHubProjectApp(t.Context(), project, actor, app, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("failed-root callback"); return nil })
			if err == nil || c.Outcome != store.TransactionNotCommitted {
				t.Fatalf("failure completion: %+v %v", c, err)
			}
		})
	}
	s, actor, project, _, app, _ := projectAppScopeFixture(t)
	missing := uuid.NewString()
	if _, err := s.WriteGitHubProjectApp(t.Context(), project, actor, missing, func(store.GitHubProjectAppWriteDAO) error { return nil }); err != nil {
		t.Fatalf("missing unbound App should be checked by core: %v", err)
	}
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,app_resource_id) VALUES($1,$2)`, project, missing)
	if _, err := s.WriteGitHubProjectApp(t.Context(), project, actor, app, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("inconsistent callback"); return nil }); err == nil {
		t.Fatal("missing referenced App hidden")
	}
	s.Pool.Close()
	if _, err := s.WriteGitHubProjectApp(t.Context(), project, actor, app, func(store.GitHubProjectAppWriteDAO) error { t.Fatal("closed callback"); return nil }); err == nil {
		t.Fatal("closed pool")
	}
}
