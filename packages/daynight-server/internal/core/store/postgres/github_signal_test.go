package postgres

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	servergithub "github.com/codetreker/daynight/packages/daynight-server/internal/server/github"
	servicegithub "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	_, err := w.SignalPullRequest(ctx, store.GitHubAppPRSignal{InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now})
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
			var count int
			if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 0 {
				t.Fatalf("pending %d %v", count, err)
			}
		})
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
	var count int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, f.project).Scan(&count); err != nil || count != 1 {
		t.Fatalf("actual committed hint %d %v", count, err)
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
					if hold {
						close(entered)
						select {
						case <-release:
						case <-ctx.Done():
							return ctx.Err()
						}
					}
					now := time.Now().UTC()
					n, e := w.SignalPullRequest(ctx, store.GitHubAppPRSignal{InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "race", ReceivedAt: now, NextAttemptAt: now})
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
				for _, row := range []struct{ query, id string }{
					{`SELECT id FROM github_apps WHERE id=$1 FOR UPDATE NOWAIT`, f.app},
					{`SELECT id FROM github_app_team_grants WHERE id=$1 FOR UPDATE NOWAIT`, f.grant},
				} {
					var id string
					err := f.db.Pool.QueryRow(ctx, row.query, row.id).Scan(&id)
					var failure *pgconn.PgError
					if !errors.As(err, &failure) || failure.Code != "55P03" {
						t.Fatalf("expected callback to hold row lock for %s: %v", row.query, err)
					}
				}
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
			err := f.db.Pool.QueryRow(ctx, `SELECT (SELECT revoked_at IS NOT NULL FROM github_app_team_grants WHERE id=$2),NOT enabled AND NOT sync_enabled AND app_resource_id IS NULL AND team_grant_id IS NULL,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1) FROM project_github WHERE project_id=$1`, f.project, f.grant).Scan(&revoked, &stopped, &count)
			if err != nil || !revoked || !stopped || count != 0 {
				t.Fatalf("revoked=%t stopped=%t pending=%d err=%v", revoked, stopped, count, err)
			}
		})
	}
}

func TestAppSignalScopeDatabaseFailurePaths(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAppSignalScopeFixture(t)
	for _, tc := range []struct{ name, mutation, restore string }{
		{"App lock query", `ALTER TABLE github_apps RENAME TO unavailable_apps`, `ALTER TABLE unavailable_apps RENAME TO github_apps`},
		{"grant lock query", `ALTER TABLE github_app_team_grants RENAME TO unavailable_grants`, `ALTER TABLE unavailable_grants RENAME TO github_app_team_grants`},
	} {
		if !t.Run(tc.name, func(t *testing.T) {
			mustQueryExec(t, f.db, tc.mutation)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if _, err := f.db.Pool.Exec(ctx, tc.restore); err != nil {
					t.Fatal(err)
				}
				f.db.Pool.Reset()
				completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(store.GitHubAppSignalWriter) error { return nil })
				if err != nil || completion.Outcome != store.TransactionCommitted {
					t.Fatalf("restored signal scope: %+v %v", completion, err)
				}
			})
			f.db.Pool.Reset()
			called := false
			completion, err := f.db.WriteGitHubAppSignals(t.Context(), f.app, 1, func(store.GitHubAppSignalWriter) error { called = true; return nil })
			var failure *pgconn.PgError
			if called || !errors.As(err, &failure) || failure.Code != "42P01" || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("called=%t completion=%+v error=%v", called, completion, err)
			}
		}) {
			return
		}
	}
	t.Run("cancel before begin", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		called := false
		completion, err := f.db.WriteGitHubAppSignals(ctx, f.app, 1, func(store.GitHubAppSignalWriter) error { called = true; return nil })
		if called || !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("called=%t completion=%+v error=%v", called, completion, err)
		}
	})
}

func githubDelivery(t *testing.T, handler http.Handler, event, delivery, body string) int {
	t.Helper()
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write([]byte(body))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/apps/"+testWebhookAppID+"/webhook", bytes.NewBufferString(body))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", delivery)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response.Code
}

func githubWebhookHandler(t *testing.T, db *Store) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	receiver, err := servicegithub.NewAppWebhookReceiver(db, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	servergithub.RegisterAppWebhookRoute(mux, receiver, logger)
	return mux
}

const testWebhookAppID = "58484824-12a6-42f3-914a-052a6673403b"

func configureWebhookApp(t *testing.T, db *Store, projectID string) {
	t.Helper()
	mustQueryExec(t, db, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,10,'app','app','app','key','secret') ON CONFLICT DO NOTHING`, testWebhookAppID)
	var team, grant string
	if err := db.Pool.QueryRow(t.Context(), `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, projectID).Scan(&team); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, uuid.NewString(), testWebhookAppID, team)
	if err := db.Pool.QueryRow(t.Context(), `SELECT id::text FROM github_app_team_grants WHERE app_resource_id=$1 AND team_id=$2 AND revoked_at IS NULL`, testWebhookAppID, team).Scan(&grant); err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `UPDATE project_github SET app_resource_id=$2,team_grant_id=$3,credential_version=1 WHERE project_id=$1`, projectID, testWebhookAppID, grant)
}

func TestGitHubWebhookReceptionAndRecoveryWithStore(t *testing.T) {
	db := isolatedStore(t)
	a, b, disconnected := queryProject(t, db, 1), queryProject(t, db, 2), queryProject(t, db, 3)
	for _, id := range []string{a.ID, b.ID, disconnected.ID} {
		b2Configure(t, db, id, 10, 20, 30)
		configureWebhookApp(t, db, id)
		mustQueryExec(t, db, `UPDATE project_github SET repository_full_name='owner/repo', next_poll_at=clock_timestamp()+interval '1 hour', next_access_check_at=clock_timestamp()+interval '1 hour' WHERE project_id=$1`, id)
	}
	mustQueryExec(t, db, `UPDATE project_github SET enabled=false, sync_enabled=false WHERE project_id=$1`, disconnected.ID)
	body := `{"installation":{"id":20},"repository":{"id":30},"number":7,"action":"closed"}`
	h := githubWebhookHandler(t, db)
	for _, delivery := range []string{"new", "new", "older"} {
		if code := githubDelivery(t, h, "pull_request", delivery, body); code != http.StatusAccepted {
			t.Fatalf("delivery: %d", code)
		}
	}
	var count int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE number=7`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("fanout pending: %d %v", count, err)
	}
	// Reconstruct the receiver and executor after reception; persisted work remains due.
	h = githubWebhookHandler(t, db)
	due, err := db.DueGitHubAppProjects(t.Context(), time.Now().Add(time.Second), 32)
	if err != nil || len(due) != 2 {
		t.Fatalf("due after restart: %v %v", due, err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	fact := executorFact(7, "open", "current", "current body", now)
	remote := &controlledGitHub{pulls: map[int64]githubpr.Observation{7: fact}, page: []githubpr.Observation{fact}}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	executor := controlledAppExecutor(t, db, remote, logger)
	if err = executor.Execute(t.Context(), a.ID); err != nil {
		t.Fatalf("hint: %v", err)
	}
	assertHintCheckpoint(t, logs.String(), "older")
	var head string
	if err = db.Pool.QueryRow(t.Context(), `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=7`, a.ID).Scan(&head); err != nil || head != "current" {
		t.Fatalf("current fact: %s %v", head, err)
	}
	// No delivery for the next update: a due poll still reconciles current facts.
	fact.HeadSHA = "poll-repair"
	remote.page = []githubpr.Observation{fact}
	remote.pulls[8] = executorFact(8, "open", "hint", "hint body", now)
	pollHint := `{"installation":{"id":20},"repository":{"id":30},"number":8}`
	if code := githubDelivery(t, h, "pull_request", "during-poll", pollHint); code != http.StatusAccepted {
		t.Fatalf("poll hint: %d", code)
	}
	logs.Reset()
	mustQueryExec(t, db, `UPDATE project_github SET next_poll_at=clock_timestamp()-interval '1 second' WHERE project_id=$1`, a.ID)
	if err = executor.Execute(t.Context(), a.ID); err != nil {
		t.Fatalf("poll: %v", err)
	}
	assertHintCheckpoint(t, logs.String(), "during-poll")
	if err = db.Pool.QueryRow(t.Context(), `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=7`, a.ID).Scan(&head); err != nil || head != "poll-repair" {
		t.Fatalf("poll repair: %s %v", head, err)
	}
	access := `{"installation":{"id":20},"repositories_removed":[]}`
	if code := githubDelivery(t, h, "installation_repositories", "access", access); code != http.StatusAccepted {
		t.Fatalf("access delivery: %d", code)
	}
	if err = db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github WHERE access_hint_id IS NOT NULL AND last_webhook_received_at IS NOT NULL`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("access fanout: %d %v", count, err)
	}
	var enabled bool
	if err = db.Pool.QueryRow(t.Context(), `SELECT enabled FROM project_github WHERE project_id=$1`, disconnected.ID).Scan(&enabled); err != nil || enabled {
		t.Fatalf("disconnect: %t %v", enabled, err)
	}
}

func assertHintCheckpoint(t *testing.T, logs, delivery string) {
	t.Helper()
	for _, line := range strings.Split(logs, "\n") {
		if strings.Contains(line, `"msg":"github request checkpoint"`) && strings.Contains(line, `"delivery_id":"`+delivery+`"`) && strings.Contains(line, `"hint_id":`) {
			return
		}
	}
	t.Fatalf("checkpoint missing hint context for %s: %s", delivery, logs)
}

func TestGitHubSignalDeadlineReleasesBlockedConnection(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	b2Configure(t, db, project.ID, 10, 20, 30)
	configureWebhookApp(t, db, project.ID)

	pool, err := pgxpool.NewWithConfig(t.Context(), db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	receiver, err := servicegithub.NewAppWebhookReceiver(&Store{Pool: pool}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	receiverConn, err := pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	receiverConn.Release()

	lock, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := lock.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release signal row lock: %v", err)
		}
	}()
	if _, err := lock.Exec(t.Context(), `SELECT project_id FROM project_github WHERE project_id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	observer, err := db.Pool.Acquire(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	observer.Release()

	watchdog, stop := context.WithTimeout(t.Context(), 4*time.Second)
	defer stop()
	request, cancel := context.WithTimeout(watchdog, 750*time.Millisecond)
	done := make(chan error, 1)
	stopped := make(chan struct{})
	defer releaseRowLockAndDrain(t, cancel, lock, stopped)
	go func() {
		defer close(stopped)
		done <- receiver.ReceiveAppWebhook(request, servicegithub.AppWebhookIdentity{AppID: testWebhookAppID, CredentialVersion: 1}, coregithub.WebhookEvent{Kind: "pull_request", DeliveryID: "blocked", InstallationID: 20, RepositoryID: 30, Number: 7})
	}()
	waitTransferTeamLock(t, request, db, "SELECT c.project_id FROM project_github c", lock.Conn().PgConn().PID())
	if err := request.Err(); err != nil {
		t.Fatalf("request expired before the lock was observed: %v", err)
	}
	select {
	case err = <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("blocked signal lost its request deadline: %v", err)
		}
	case <-watchdog.Done():
		t.Fatal("signal exceeded deadline")
	}

	// pgxpool releases a closed connection after its transport cleanup finishes.
	drain, stopDrain := context.WithTimeout(t.Context(), 2*time.Second)
	defer stopDrain()
	for pool.Stat().AcquiredConns() != 0 {
		if err := waitThreadClock(drain); err != nil {
			t.Fatalf("connection still acquired: %+v, %v", pool.Stat(), err)
		}
	}
	if err := lock.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("pending=%d err=%v", count, err)
	}
}
