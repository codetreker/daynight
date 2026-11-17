package postgres

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGitHubGrantLostCommitReceipt(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := t.Context()
	actor, app, teamID, grant, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'team')`, teamID)
	mustQueryExec(t, s, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret,impact_version) VALUES($1,1,'app','remote','slug','k','s',2)`, app)
	mustQueryExec(t, s, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, app, actor)
	mustQueryExec(t, s, `INSERT INTO github_app_team_grants(id,team_id,app_resource_id) VALUES($1,$2,$3)`, grant, teamID, app)
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,app_resource_id,team_grant_id,enabled,sync_enabled,repository_id) VALUES($1,$2,$3,true,true,42)`, project, app, grant)
	mustQueryExec(t, s, `INSERT INTO project_pull_requests(project_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,1,1,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project)
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
		return core.RevokeGrant(ctx, w, p, grant, core.RevokeGrantInput{ExpectedUserID: actor, Version: 1, ImpactVersion: 2})
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
