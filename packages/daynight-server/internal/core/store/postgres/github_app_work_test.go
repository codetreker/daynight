package postgres

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	githubdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	syncgithub "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
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
	parallelRootDatabaseTest(t)
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
		err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=current_setting('application_name')
			AND wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid())`, query).Scan(&waiting)
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
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
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

// controlledGitHub supplies facts through the real remote client transport.
type controlledGitHub struct {
	page       []githubpr.Observation
	pulls      map[int64]githubpr.Observation
	duringPull func(context.Context, int64) error
	beforeList func(context.Context) error
}

type fixedAppClient struct{ client *remote.Client }

func (p fixedAppClient) Acquire(_ context.Context, id string, version int64) (*remote.Client, func(), error) {
	if id != testWebhookAppID || version != 1 {
		return nil, nil, fmt.Errorf("unexpected App identity")
	}
	return p.client, func() {}, nil
}

func observationJSON(v githubpr.Observation) map[string]any {
	return map[string]any{
		"id": v.GitHubID, "number": v.Number, "html_url": v.URL, "title": v.Title, "state": v.State, "draft": v.Draft, "user": nil,
		"base":       map[string]any{"ref": v.BaseRef, "repo": map[string]any{"id": v.BaseRepositoryID}},
		"head":       map[string]any{"ref": v.HeadRef, "sha": v.HeadSHA, "repo": nil},
		"created_at": v.CreatedAt, "updated_at": v.UpdatedAt, "closed_at": v.ClosedAt, "merged_at": v.MergedAt, "body": v.Description,
	}
}

func controlledAppExecutor(t *testing.T, db *Store, upstream *controlledGitHub, logger *slog.Logger) *syncgithub.AppExecutor {
	t.Helper()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/app/installations/20/access_tokens":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"test","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case r.URL.Path == "/app/installations/20":
			fmt.Fprint(w, `{"id":20,"suspended_at":null}`)
		case r.URL.Path == "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"id":30,"full_name":"owner/repo","private":true}]}`)
		case r.URL.Path == "/repos/owner/repo":
			fmt.Fprint(w, `{"id":30,"full_name":"owner/repo","private":true}`)
		case r.URL.Path == "/repos/owner/repo/pulls":
			if r.URL.Query().Get("per_page") == "1" {
				fmt.Fprint(w, `[]`)
				return
			}
			if upstream.beforeList != nil {
				if err := upstream.beforeList(r.Context()); err != nil {
					http.Error(w, "cancelled", http.StatusServiceUnavailable)
					return
				}
			}
			items := make([]map[string]any, 0, len(upstream.page))
			for _, item := range upstream.page {
				items = append(items, observationJSON(item))
			}
			_ = json.NewEncoder(w).Encode(items)
		case strings.HasPrefix(r.URL.Path, "/repos/owner/repo/pulls/"):
			number, err := strconv.ParseInt(strings.TrimPrefix(r.URL.Path, "/repos/owner/repo/pulls/"), 10, 64)
			if err != nil {
				http.Error(w, "invalid", http.StatusBadRequest)
				return
			}
			if upstream.duringPull != nil {
				if err := upstream.duringPull(r.Context(), number); err != nil {
					http.Error(w, "hook failed", http.StatusServiceUnavailable)
					return
				}
			}
			item, ok := upstream.pulls[number]
			if !ok {
				for _, observed := range upstream.page {
					if observed.Number == number {
						item, ok = observed, true
						break
					}
				}
			}
			if !ok {
				http.Error(w, "missing", http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(w).Encode(observationJSON(item))
		default:
			http.Error(w, "unexpected", http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "api.github.com:443" {
			return nil, fmt.Errorf("unexpected destination %q", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	http.DefaultTransport = transport
	client, err := remote.NewClient(10, key)
	http.DefaultTransport = original
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.CloseIdleConnections(); transport.CloseIdleConnections() })
	executor, err := syncgithub.NewAppExecutor(db, fixedAppClient{client}, logger)
	if err != nil {
		t.Fatal(err)
	}
	return executor
}

func executorFact(number int64, state, sha, description string, at time.Time) githubpr.Observation {
	return githubpr.Observation{Number: number, GitHubID: 100 + number, URL: fmt.Sprintf("https://github.com/owner/repo/pull/%d", number), Title: "title", State: state, BaseRepositoryID: 30, BaseRef: "main", HeadSHA: sha, CreatedAt: at, UpdatedAt: at, Description: &description}
}

func TestGitHubExecutorPersistsPollAndConcurrentHint(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	b2Configure(t, db, project.ID, 10, 20, 30)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	mustQueryExec(t, db, `UPDATE project_github SET repository_full_name='owner/repo', installation_account_login='owner', next_poll_at=clock_timestamp() WHERE project_id=$1`, project.ID)
	now := time.Now().UTC().Truncate(time.Microsecond)
	first := executorFact(1, "open", "one", "旧正文", now)
	second := executorFact(2, "open", "two", "second", now)
	upstream := &controlledGitHub{page: []githubpr.Observation{first, second}, pulls: map[int64]githubpr.Observation{}}
	executor := controlledAppExecutor(t, db, upstream, slog.New(slog.NewTextHandler(io.Discard, nil)))
	var err error
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("first poll: %v", err)
	}
	var firstSuccess time.Time
	var gen int64
	var claim *string
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at,last_full_generation,claim_token::text,(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project.ID).Scan(&firstSuccess, &gen, &claim, &count); err != nil || firstSuccess.IsZero() || gen != 1 || claim != nil || count != 2 {
		t.Fatalf("initial: success=%s gen=%d claim=%v count=%d err=%v", firstSuccess, gen, claim, count, err)
	}
	// The second poll sees a same-second head change and individually confirms
	// that the missing previously active PR closed.
	first.HeadSHA = "changed-same-second"
	first.Description = pointerString("新正文")
	second.State = "closed"
	second.ClosedAt = &now
	upstream.page = []githubpr.Observation{first}
	upstream.pulls[2] = second
	mustQueryExec(t, db, `UPDATE project_github SET next_poll_at=clock_timestamp() WHERE project_id=$1`, project.ID)
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("second poll: %v", err)
	}
	var sha, body, state string
	if err = db.Pool.QueryRow(ctx, `SELECT head_sha,description FROM project_pull_requests WHERE project_id=$1 AND number=1`, project.ID).Scan(&sha, &body); err != nil || sha != "changed-same-second" || body != "新正文" {
		t.Fatalf("open fact: %s %s %v", sha, body, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT state FROM project_pull_requests WHERE project_id=$1 AND number=2`, project.ID).Scan(&state); err != nil || state != "closed" {
		t.Fatalf("absent fact: %s %v", state, err)
	}
	var nextSuccess time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at FROM project_github WHERE project_id=$1`, project.ID).Scan(&nextSuccess); err != nil || nextSuccess.Before(firstSuccess) {
		t.Fatalf("complete poll: %s %v", nextSuccess, err)
	}

	// Reopening the same PR restores the retained row to the active set.
	second.State, second.ClosedAt, second.HeadSHA = "open", nil, "reopened-head"
	second.Description = pointerString("reopened body")
	upstream.pulls[2] = second
	upstream.page = []githubpr.Observation{first, second}
	mustQueryExec(t, db, `UPDATE project_github SET next_poll_at=clock_timestamp() WHERE project_id=$1`, project.ID)
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("reopen poll: %v", err)
	}
	var githubID int64
	var closedAt *time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT state,github_id,head_sha,description,github_closed_at FROM project_pull_requests WHERE project_id=$1 AND number=2`, project.ID).Scan(&state, &githubID, &sha, &body, &closedAt); err != nil || state != "open" || githubID != second.GitHubID || sha != "reopened-head" || body != "reopened body" || closedAt != nil {
		t.Fatalf("reopened fact: state=%s id=%d head=%s body=%s closed=%v err=%v", state, githubID, sha, body, closedAt, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("reopen created duplicate records: %d %v", count, err)
	}
	var reopenedSuccess time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at FROM project_github WHERE project_id=$1`, project.ID).Scan(&reopenedSuccess); err != nil || reopenedSuccess.Before(nextSuccess) {
		t.Fatalf("reopen poll completion: %s %v", reopenedSuccess, err)
	}
	nextSuccess = reopenedSuccess

	request1, request2 := uuid.NewString(), uuid.NewString()
	signal := store.GitHubAppPRSignal{InstallationID: 20, RepositoryID: 30, Number: 1, RequestID: request1, DeliveryID: "one", ReceivedAt: now, NextAttemptAt: now}
	if got := b2Signal(t, db, signal); got != 1 {
		t.Fatalf("first signal: %d", got)
	}
	first.HeadSHA = "event-first"
	upstream.pulls[1] = first
	upstream.duringPull = func(ctx context.Context, n int64) error {
		if n != 1 {
			return fmt.Errorf("unexpected hint %d", n)
		}
		upstream.duringPull = nil
		signal.RequestID, signal.DeliveryID = request2, "two"
		completion, err := db.WriteGitHubAppSignals(ctx, testWebhookAppID, 1, func(w store.GitHubAppSignalWriter) error { _, err := w.SignalPullRequest(ctx, signal); return err })
		if err != nil || completion.Outcome != store.TransactionCommitted {
			return fmt.Errorf("replace signal: %+v %w", completion, err)
		}
		return nil
	}
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("first hint: %v", err)
	}
	var pending string
	if err = db.Pool.QueryRow(ctx, `SELECT request_id::text FROM project_github_pending_prs WHERE project_id=$1 AND number=1`, project.ID).Scan(&pending); err != nil || pending != request2 {
		t.Fatalf("new hint lost: %s %v", pending, err)
	}
	first.HeadSHA = "event-second"
	upstream.pulls[1] = first
	if err = executor.Execute(ctx, project.ID); err != nil {
		t.Fatalf("second hint: %v", err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=1`, project.ID).Scan(&sha); err != nil || sha != "event-second" {
		t.Fatalf("second hint: %s %v", sha, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("hint acknowledgement: %d %v", count, err)
	}
	var afterHints time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT last_full_success_at FROM project_github WHERE project_id=$1`, project.ID).Scan(&afterHints); err != nil || !afterHints.Equal(nextSuccess) {
		t.Fatalf("hints changed poll success: %s %v", afterHints, err)
	}
}
func pointerString(v string) *string { return &v }

func TestGitHubExecutorsStopOldObservationAcrossInstances(t *testing.T) {
	db := isolatedStore(t)
	project, other := queryProject(t, db, 1), queryProject(t, db, 2)
	b2Configure(t, db, project.ID, 10, 20, 30)
	b2Configure(t, db, other.ID, 10, 20, 30)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	mustQueryExec(t, db, `UPDATE project_github SET repository_full_name='owner/repo',installation_account_login='owner',next_poll_at=clock_timestamp()`)
	pool, err := pgxpool.NewWithConfig(ctx, db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	secondDB := &Store{Pool: pool}
	now := time.Now().UTC().Truncate(time.Microsecond)
	entered, release := make(chan struct{}), make(chan struct{})
	oldRemote := &controlledGitHub{page: []githubpr.Observation{executorFact(1, "open", "old", "old", now)}, beforeList: func(ctx context.Context) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}}
	nextRemote := &controlledGitHub{page: []githubpr.Observation{executorFact(2, "open", "new", "new", now)}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	first := controlledAppExecutor(t, db, oldRemote, logger)
	second := controlledAppExecutor(t, secondDB, nextRemote, logger)
	done := make(chan error, 1)
	go func() { done <- first.Execute(ctx, project.ID) }()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	b2ManageWrite(t, secondDB, project.ID, func(ctx context.Context, dao store.GitHubProjectAppWriteDAO, facts store.GitHubProjectAppFacts) error {
		c := facts.Connection
		ok, err := b2Save(dao, ctx, facts, store.GitHubConfigurationWrite{ExpectedVersion: c.Version, Version: c.Version + 1, Generation: c.Generation + 1, Revision: c.Revision + 1, Enabled: true, SyncEnabled: false, AppID: c.AppID, InstallationID: c.InstallationID, RepositoryID: c.RepositoryID, InstallationAccountLogin: c.InstallationAccountLogin, RepositoryFullName: c.RepositoryFullName, RepositoryPrivate: c.RepositoryPrivate, PollIntervalMinutes: c.PollIntervalMinutes, AccessState: c.AccessState}, false)
		if err != nil || !ok {
			return fmt.Errorf("stop: %t %v", ok, err)
		}
		return nil
	})
	if err := second.Execute(ctx, project.ID); err != nil {
		t.Fatalf("disabled executor: %v", err)
	}
	if err := second.Execute(ctx, other.ID); err != nil {
		t.Fatalf("other executor: %v", err)
	}
	close(release)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("old executor published after stop")
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var stopped, otherCount int
	var enabled, syncEnabled bool
	var claim *string
	if err := db.Pool.QueryRow(ctx, `SELECT enabled,sync_enabled,claim_token::text,(SELECT count(*) FROM project_pull_requests WHERE project_id=$1),(SELECT count(*) FROM project_pull_requests WHERE project_id=$2) FROM project_github WHERE project_id=$1`, project.ID, other.ID).Scan(&enabled, &syncEnabled, &claim, &stopped, &otherCount); err != nil || !enabled || syncEnabled || claim != nil || stopped != 0 || otherCount != 1 {
		t.Fatalf("stopped=%d other=%d enabled=%t sync=%t claim=%v error=%v", stopped, otherCount, enabled, syncEnabled, claim, err)
	}
	b2ManageWrite(t, db, project.ID, func(ctx context.Context, dao store.GitHubProjectAppWriteDAO, facts store.GitHubProjectAppFacts) error {
		c := facts.Connection
		ok, err := b2Save(dao, ctx, facts, store.GitHubConfigurationWrite{ExpectedVersion: c.Version, Version: c.Version + 1, Generation: c.Generation + 1, Revision: c.Revision + 1, Enabled: true, SyncEnabled: true, AppID: c.AppID, InstallationID: c.InstallationID, RepositoryID: c.RepositoryID, InstallationAccountLogin: c.InstallationAccountLogin, RepositoryFullName: c.RepositoryFullName, RepositoryPrivate: c.RepositoryPrivate, PollIntervalMinutes: c.PollIntervalMinutes, AccessState: c.AccessState, NextPollAt: &now}, false)
		if err != nil || !ok {
			return fmt.Errorf("restart: %t %v", ok, err)
		}
		return nil
	})
	if err := second.Execute(ctx, project.ID); err != nil {
		t.Fatalf("new generation: %v", err)
	}
	var sha string
	if err := db.Pool.QueryRow(ctx, `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=2`, project.ID).Scan(&sha); err != nil || sha != "new" {
		t.Fatalf("new generation observation: %q %v", sha, err)
	}
}

func TestAppExecutorRealProviderAndPublicationFence(t *testing.T) {
	db := isolatedStore(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	for n, change := range []string{"normal", "credential", "grant"} {
		t.Run(change, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			project := queryProject(t, db, n+1)
			app, grant := uuid.NewString(), uuid.NewString()
			appID := int64(91 + n)
			mustQueryExec(t, db, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,$2,'App','App','app',$3,'secret')`, app, appID, pemKey)
			mustQueryExec(t, db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, grant, app, project.Ownership.TeamID)
			mustQueryExec(t, db, `INSERT INTO project_github(project_id,generation,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,repository_full_name,installation_account_login,next_poll_at) VALUES($1,1,true,true,$2,20,30,$3,$4,1,'available','owner/repo','owner',now())`, project.ID, appID, app, grant)
			entered, release := make(chan struct{}), make(chan struct{})
			pull := `{"id":420,"number":42,"html_url":"https://github.com/owner/repo/pull/42","title":"Observed PR","state":"open","draft":false,"user":null,"base":{"ref":"main","repo":{"id":30}},"head":{"ref":"feature","sha":"current-sha","repo":null},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:01Z","closed_at":null,"merged_at":null,"body":"Observed body"}`
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/app/installations/20/access_tokens":
					if r.Method != http.MethodPost {
						t.Errorf("token method: %s", r.Method)
					}
					w.WriteHeader(http.StatusCreated)
					fmt.Fprintf(w, `{"token":"installation-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
				case "/repos/owner/repo":
					io.WriteString(w, `{"id":30,"full_name":"owner/repo","private":true}`)
				case "/repos/owner/repo/pulls":
					if r.URL.Query().Get("per_page") == "1" {
						io.WriteString(w, `[]`)
						return
					}
					if r.URL.Query().Get("state") == "all" {
						close(entered)
						select {
						case <-release:
						case <-r.Context().Done():
							return
						}
					}
					io.WriteString(w, "["+pull+"]")
				case "/repos/owner/repo/pulls/42":
					io.WriteString(w, pull)
				default:
					t.Errorf("unexpected GitHub request: %s", r.URL.Path)
					w.WriteHeader(http.StatusInternalServerError)
				}
			}))
			defer srv.Close()
			roots := x509.NewCertPool()
			roots.AddCert(srv.Certificate())
			original := http.DefaultTransport
			transport := original.(*http.Transport).Clone()
			transport.Proxy = nil
			transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
			transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				if address != "api.github.com:443" {
					return nil, fmt.Errorf("unexpected destination %q", address)
				}
				return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
			}
			http.DefaultTransport = transport
			defer func() { http.DefaultTransport = original; transport.CloseIdleConnections() }()
			provider, err := syncgithub.NewClientProvider(githubdao.NewAppCredentialReader(db.Pool))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cancel()
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cleanupCancel()
				if err := provider.Close(cleanupCtx); err != nil {
					t.Error(err)
				}
			}()
			executor, err := syncgithub.NewAppExecutor(db, provider, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- executor.Execute(ctx, project.ID) }()
			select {
			case <-entered:
			case err := <-done:
				t.Fatalf("execution stopped before poll: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if change != "normal" {
				tx, err := db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err := tx.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, app); err != nil {
					t.Fatal(err)
				}
				if change == "credential" {
					_, err = tx.Exec(ctx, `UPDATE github_apps SET credential_version=credential_version+1 WHERE id=$1`, app)
				} else {
					_, err = tx.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, grant)
				}
				if err != nil {
					t.Fatal(err)
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			err = <-done
			var count int
			var success *time.Time
			var claim *string
			if queryErr := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_pull_requests WHERE project_id=$1),last_full_success_at,claim_token::text FROM project_github WHERE project_id=$1`, project.ID).Scan(&count, &success, &claim); queryErr != nil {
				t.Fatal(queryErr)
			}
			if change == "normal" {
				if err != nil || count != 1 || success == nil || claim != nil {
					t.Fatalf("normal publication: err=%v count=%d success=%v claim=%v", err, count, success, claim)
				}
				var body, sha string
				if err := db.Pool.QueryRow(ctx, `SELECT description,head_sha FROM project_pull_requests WHERE project_id=$1 AND number=42`, project.ID).Scan(&body, &sha); err != nil || body != "Observed body" || sha != "current-sha" {
					t.Fatalf("observation: %q %q %v", body, sha, err)
				}
			} else if !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || count != 0 || success != nil {
				t.Fatalf("old response escaped %s fence: err=%v count=%d success=%v", change, err, count, success)
			}
		})
	}
}
