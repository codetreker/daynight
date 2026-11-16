package postgres

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func appWorkScopeFixture(t *testing.T) (*Store, string, store.GitHubAppWorkIdentity) {
	t.Helper()
	s := isolatedStore(t)
	project := uuid.NewString()
	i := store.GitHubAppWorkIdentity{AppResourceID: uuid.NewString(), GrantID: uuid.NewString(), TeamID: uuid.NewString(), AppID: 91, CredentialVersion: 1, OwnershipVersion: 1}
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','repo')`, project)
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'Team')`, i.TeamID)
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, i.TeamID)
	mustQueryExec(t, s, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','App','app','key','secret')`, i.AppResourceID)
	mustQueryExec(t, s, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, i.GrantID, i.AppResourceID, i.TeamID)
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,generation,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,next_poll_at) VALUES($1,1,true,true,91,20,30,$2,$3,1,'available',now())`, project, i.AppResourceID, i.GrantID)
	return s, project, i
}

func appWorkClaim(ctx context.Context, w store.GitHubAppWorkDAO, token string) (bool, error) {
	now, err := w.ObservedAt(ctx)
	if err != nil {
		return false, err
	}
	return w.Claim(ctx, store.GitHubClaim{AppID: 91, Generation: 1, Token: token, Kind: "poll", Until: now.Add(5 * time.Minute)})
}

func TestAppWorkScopeRollbackAndOriginalIdentity(t *testing.T) {
	s, project, identity := appWorkScopeFixture(t)
	ctx := t.Context()
	token := uuid.NewString()
	abort := errors.New("abort")
	c, err := s.WriteGitHubAppWork(ctx, project, nil, func(w store.GitHubAppWorkDAO) error {
		if w.Identity() != identity {
			t.Fatalf("identity: %+v", w.Identity())
		}
		if ok, err := appWorkClaim(ctx, w, token); err != nil || !ok {
			t.Fatalf("claim: %v %v", ok, err)
		}
		return abort
	})
	if !errors.Is(err, abort) || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", c, err)
	}
	var claim *string
	if err := s.Pool.QueryRow(ctx, `SELECT claim_token::text FROM project_github WHERE project_id=$1`, project).Scan(&claim); err != nil || claim != nil {
		t.Fatalf("rollback claim: %v %v", claim, err)
	}
	c, err = s.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
		ok, err := appWorkClaim(ctx, w, token)
		if err == nil && !ok {
			return errors.New("claim refused")
		}
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("claim commit: %+v %v", c, err)
	}
	lease := store.GitHubLease{Generation: 1, Token: token}
	c, err = s.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
		ok, err := w.ValidLease(ctx, lease)
		if err == nil && !ok {
			return errors.New("committed lease missing")
		}
		return err
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("checkpoint: %+v %v", c, err)
	}
	mustQueryExec(t, s, `UPDATE github_apps SET credential_version=2 WHERE id=$1`, identity.AppResourceID)
	mustQueryExec(t, s, `UPDATE project_github SET credential_version=2 WHERE project_id=$1`, project)
	called := false
	c, err = s.WriteGitHubAppWork(ctx, project, &identity, func(store.GitHubAppWorkDAO) error { called = true; return nil })
	if !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || called || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old identity followed new credentials: %+v %v %v", c, err, called)
	}
	newer := identity
	newer.CredentialVersion = 2
	c, err = s.WriteGitHubAppWork(ctx, project, &newer, func(w store.GitHubAppWorkDAO) error { return nil })
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("new credentials: %+v %v", c, err)
	}
	mustQueryExec(t, s, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, identity.GrantID)
	replacement := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, replacement, identity.AppResourceID, identity.TeamID)
	mustQueryExec(t, s, `UPDATE project_github SET team_grant_id=$2 WHERE project_id=$1`, project, replacement)
	c, err = s.WriteGitHubAppWork(ctx, project, &newer, func(store.GitHubAppWorkDAO) error { called = true; return nil })
	if !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || called || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old grant revived: %+v %v %v", c, err, called)
	}
}

func waitAppWorkLock(t *testing.T, s *Store, query string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for {
		var waiting bool
		err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid())`, query).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("expected work lock was not observed")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestAppWorkConcurrentInstancesClaimOnce(t *testing.T) {
	s, project, identity := appWorkScopeFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	second, err := Open(ctx, s.Pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	firstClaimed, release := make(chan struct{}), make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		_, err := s.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
			ok, err := appWorkClaim(ctx, w, uuid.NewString())
			if err != nil {
				return err
			}
			if !ok {
				return errors.New("first claim refused")
			}
			close(firstClaimed)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		firstDone <- err
	}()
	<-firstClaimed
	secondDone := make(chan error, 1)
	secondClaimed := false
	go func() {
		_, err := second.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
			var err error
			secondClaimed, err = appWorkClaim(ctx, w, uuid.NewString())
			return err
		})
		secondDone <- err
	}()
	waitAppWorkLock(t, s, "%FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE%")
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := <-secondDone; err != nil || secondClaimed {
		t.Fatalf("duplicate claim: %v %v", secondClaimed, err)
	}
}

func TestAppWorkWaitsForInvalidationBeforeClaim(t *testing.T) {
	s, project, identity := appWorkScopeFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	invalidation, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer invalidation.Rollback(context.Background())
	if _, err := invalidation.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, identity.AppResourceID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	called := false
	go func() {
		_, err := s.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
			called = true
			_, err := appWorkClaim(ctx, w, uuid.NewString())
			return err
		})
		done <- err
	}()
	waitAppWorkLock(t, s, "%FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR SHARE%")
	if _, err := invalidation.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, identity.GrantID); err != nil {
		t.Fatal(err)
	}
	if _, err := invalidation.Exec(ctx, `UPDATE project_github SET enabled=false,sync_enabled=false,generation=generation+1,claim_token=NULL,claim_until=NULL,claim_kind=NULL WHERE project_id=$1`, project); err != nil {
		t.Fatal(err)
	}
	if err := invalidation.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || called {
		t.Fatalf("revocation lost after wait: %v called=%v", err, called)
	}
}

func TestAppWorkScopeLostCommitReceipt(t *testing.T) {
	s, project, identity := appWorkScopeFixture(t)
	ctx := t.Context()
	var armed, lost atomic.Bool
	cfg := s.Pool.Config().Copy()
	cfg.ConnConfig.TLSConfig = nil
	cfg.ConnConfig.Fallbacks = nil
	cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	token := uuid.NewString()
	calls := 0
	armed.Store(true)
	c, err := (&Store{Pool: pool}).WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
		calls++
		ok, err := appWorkClaim(ctx, w, token)
		if err == nil && !ok {
			return errors.New("claim refused")
		}
		return err
	})
	var failure *store.TransactionError
	if !lost.Load() || c.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || calls != 1 {
		t.Fatalf("unknown: %+v %v lost=%v calls=%d", c, err, lost.Load(), calls)
	}
	var retained string
	if err := s.Pool.QueryRow(ctx, `SELECT claim_token::text FROM project_github WHERE project_id=$1`, project).Scan(&retained); err != nil || retained != token {
		t.Fatalf("persisted unknown claim: %s %v", retained, err)
	}
}

func TestAppWorkOriginalClaimRejectsOwnershipABA(t *testing.T) {
	s, project, identity := appWorkScopeFixture(t)
	ctx := t.Context()
	token := uuid.NewString()
	completion, err := s.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
		ok, err := appWorkClaim(ctx, w, token)
		if err == nil && !ok {
			return errors.New("claim refused")
		}
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("claim: %+v %v", completion, err)
	}
	otherTeam := uuid.NewString()
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'Other Team')`, otherTeam)
	for _, team := range []string{otherTeam, identity.TeamID} {
		completion, err = s.WriteProject(ctx, project, func(scope store.ProjectWriteScope) error {
			ownership, err := scope.ProjectDAO().LockTransferOwnership(ctx)
			if err != nil {
				return err
			}
			if _, err := scope.ProjectDAO().MoveOwnership(ctx, team); err != nil {
				return err
			}
			if ownership.Version < identity.OwnershipVersion {
				return errors.New("ownership version regressed")
			}
			return nil
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("transfer: %+v %v", completion, err)
		}
	}
	var otherwiseCurrent bool
	if err := s.Pool.QueryRow(ctx, `SELECT o.team_id=$2 AND o.version=3 AND g.generation=1 AND g.claim_token=$3 AND g.claim_until>clock_timestamp() AND g.enabled AND g.sync_enabled FROM project_github g JOIN project_ownership o ON o.project_id=g.project_id WHERE g.project_id=$1`, project, identity.TeamID, token).Scan(&otherwiseCurrent); err != nil || !otherwiseCurrent {
		t.Fatalf("ABA fixture did not retain the original lease: %v %v", otherwiseCurrent, err)
	}
	called := false
	completion, err = s.WriteGitHubAppWork(ctx, project, &identity, func(w store.GitHubAppWorkDAO) error {
		called = true
		_, err := w.Renew(ctx, store.GitHubLease{Generation: 1, Token: token}, time.Now().Add(time.Hour))
		return err
	})
	if !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || called || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("old ownership revived: %+v %v callback=%v", completion, err, called)
	}
}
