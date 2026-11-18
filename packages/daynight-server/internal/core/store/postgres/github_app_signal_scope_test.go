package postgres

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type appSignalScopeFixture struct {
	db                  *Store
	app, grant, project string
}

func newAppSignalScopeFixture(t *testing.T) appSignalScopeFixture {
	t.Helper()
	s := isolatedStore(t)
	team := uuid.NewString()
	f := appSignalScopeFixture{s, uuid.NewString(), uuid.NewString(), uuid.NewString()}
	mustQueryExec(t, s, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,10,'app','remote','slug','key','secret')`, f.app)
	mustQueryExec(t, s, `INSERT INTO teams(id,name) VALUES($1,'team')`, team)
	mustQueryExec(t, s, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, f.grant, f.app, team)
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'project','repo')`, f.project)
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, f.project, team)
	mustQueryExec(t, s, `INSERT INTO project_github(project_id,app_resource_id,team_grant_id,app_id,credential_version,installation_id,repository_id,enabled,sync_enabled,generation) VALUES($1,$2,$3,10,1,20,30,true,true,4)`, f.project, f.app, f.grant)
	return f
}
func scopeSignal(ctx context.Context, w store.GitHubAppSignalWriter) error {
	now := time.Now().UTC()
	_, err := w.SignalAccess(ctx, store.GitHubAppAccessSignal{InstallationID: 20, HintID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now})
	return err
}
func TestAppSignalScopeCredentialRace(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, mutation := range []string{`UPDATE github_apps SET credential_version=2,webhook_secret='new' WHERE id=$1`, `UPDATE github_apps SET deleted_at=now(),webhook_secret=NULL WHERE id=$1`} {
		t.Run(mutation, func(t *testing.T) {
			f := newAppSignalScopeFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			snap, err := f.db.ReadGitHubAppWebhook(ctx, f.app)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := f.db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err = tx.Exec(ctx, mutation, f.app); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				called := false
				c, e := f.db.WriteGitHubAppSignals(ctx, f.app, snap.CredentialVersion, func(w store.GitHubAppSignalWriter) error { called = true; return scopeSignal(ctx, w) })
				if called || c.Outcome != store.TransactionNotCommitted || !errors.Is(e, store.ErrGitHubAppWebhookChanged) {
					done <- fmt.Errorf("called=%t completion=%+v error=%v", called, c, e)
					return
				}
				done <- nil
			}()
			waitForQueryLock(t, f.db, "SELECT github_app_id,credential_version FROM github_apps")
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err = receiveQueryResult(t, ctx, done); err != nil {
				t.Fatal(err)
			}
			var hint *string
			if err = f.db.Pool.QueryRow(ctx, `SELECT access_hint_id::text FROM project_github WHERE project_id=$1`, f.project).Scan(&hint); err != nil || hint != nil {
				t.Fatalf("access hint %v %v", hint, err)
			}
		})
	}
}
func TestAppSignalScopeHoldsAppAndGrantLocks(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAppSignalScopeFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	entered := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		c, e := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error {
			close(entered)
			select {
			case <-release:
				return scopeSignal(ctx, w)
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if e == nil && c.Outcome != store.TransactionCommitted {
			e = fmt.Errorf("completion %+v", c)
		}
		done <- e
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for _, q := range []struct{ sql, id string }{{`SELECT id FROM github_apps WHERE id=$1 FOR UPDATE NOWAIT`, f.app}, {`SELECT id FROM github_app_team_grants WHERE id=$1 FOR UPDATE NOWAIT`, f.grant}} {
		tx, err := f.db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = tx.Exec(ctx, q.sql, q.id)
		_ = tx.Rollback(ctx)
		if err == nil {
			t.Fatalf("lock was not held: %s", q.sql)
		}
	}
	close(release)
	if err := receiveQueryResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
}
func TestAppSignalScopeLostCommitReceipt(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAppSignalScopeFixture(t)
	ctx := t.Context()
	var armed, lost atomic.Bool
	config := f.db.Pool.Config().Copy()
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
	armed.Store(true)
	calls := 0
	completion, err := (&Store{Pool: pool}).WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error { calls++; return scopeSignal(ctx, w) })
	if !lost.Load() || calls != 1 || completion.Outcome != store.TransactionUnknown || err == nil {
		t.Fatalf("lost=%t calls=%d completion=%+v error=%v", lost.Load(), calls, completion, err)
	}
	var delivery *string
	if err = f.db.Pool.QueryRow(ctx, `SELECT access_delivery_id FROM project_github WHERE project_id=$1`, f.project).Scan(&delivery); err != nil || delivery == nil || *delivery != "delivery" {
		t.Fatalf("actual committed hint %v %v", delivery, err)
	}
}

func TestAppSignalScopeConcurrentGrantRevocation(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, signalFirst := range []bool{true, false} {
		t.Run(fmt.Sprintf("signalFirst=%t", signalFirst), func(t *testing.T) {
			f := newAppSignalScopeFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			actor := uuid.NewString()
			var team string
			if err := f.db.Pool.QueryRow(ctx, `SELECT team_id::text FROM github_app_team_grants WHERE id=$1`, f.grant).Scan(&team); err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, f.db, `INSERT INTO github_app_admins(app_resource_id,user_id) VALUES($1,$2)`, f.app, actor)
			principal := model.Principal{UserID: actor, CredentialID: uuid.NewString(), Kind: model.SessionCredential}
			entered := make(chan struct{})
			release := make(chan struct{})
			first := make(chan error, 1)
			second := make(chan error, 1)
			signal := func(hold bool) error {
				c, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(w store.GitHubAppSignalWriter) error {
					now := time.Now().UTC()
					n, e := w.SignalAccess(ctx, store.GitHubAppAccessSignal{InstallationID: 20, HintID: uuid.NewString(), DeliveryID: "race", ReceivedAt: now})
					if e != nil {
						return e
					}
					expected := int64(0)
					if signalFirst {
						expected = 1
					}
					if n != expected {
						return fmt.Errorf("signal count %d want %d", n, expected)
					}
					if hold {
						close(entered)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
					}
					return nil
				})
				if err == nil && c.Outcome != store.TransactionCommitted {
					return fmt.Errorf("signal completion %+v", c)
				}
				return err
			}
			revoke := func(hold bool) error {
				c, err := f.db.WriteGitHubGrant(ctx, team, f.app, actor, func(w store.GitHubGrantWriteDAO) error {
					if e := coregithub.RevokeGrant(ctx, w, principal, f.grant, coregithub.RevokeGrantInput{ExpectedUserID: actor, Version: 1, ImpactVersion: 1}); e != nil {
						return e
					}
					if hold {
						close(entered)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
					}
					return nil
				})
				if err == nil && c.Outcome != store.TransactionCommitted {
					return fmt.Errorf("revoke completion %+v", c)
				}
				return err
			}
			if signalFirst {
				go func() { first <- signal(true) }()
			} else {
				go func() { first <- revoke(true) }()
			}
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if signalFirst {
				go func() { second <- revoke(false) }()
				waitForQueryLock(t, f.db, "SELECT id::text FROM github_apps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
			} else {
				go func() { second <- signal(false) }()
				waitForQueryLock(t, f.db, "SELECT github_app_id,credential_version FROM github_apps")
			}
			close(release)
			if err := receiveQueryResult(t, ctx, first); err != nil {
				t.Fatal(err)
			}
			if err := receiveQueryResult(t, ctx, second); err != nil {
				t.Fatal(err)
			}
			var revoked, stopped bool
			var count int
			err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT revoked_at IS NOT NULL FROM github_app_team_grants WHERE id=$2),NOT enabled AND NOT sync_enabled AND app_resource_id IS NULL AND team_grant_id IS NULL AND access_hint_id IS NULL,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project, f.grant).Scan(&revoked, &stopped, &count)
			if err != nil || !revoked || !stopped || count != 0 {
				t.Fatalf("revoked=%t stopped=%t pending=%d err=%v", revoked, stopped, count, err)
			}
		})
	}
}

func TestAppSignalScopeDatabaseFailurePaths(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, tc := range []struct{ name, mutation string }{
		{"App lock query", `ALTER TABLE github_apps RENAME TO unavailable_apps`},
		{"grant lock query", `ALTER TABLE github_app_team_grants RENAME TO unavailable_grants`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppSignalScopeFixture(t)
			ctx := t.Context()
			if _, err := f.db.Pool.Exec(ctx, tc.mutation); err != nil {
				t.Fatal(err)
			}
			called := false
			completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(store.GitHubAppSignalWriter) error { called = true; return nil })
			if called || err == nil || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("called=%t completion=%+v error=%v", called, completion, err)
			}
		})
	}
	t.Run("cancel before begin", func(t *testing.T) {
		f := newAppSignalScopeFixture(t)
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		called := false
		completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(store.GitHubAppSignalWriter) error { called = true; return nil })
		if called || !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("called=%t completion=%+v error=%v", called, completion, err)
		}
	})
}
