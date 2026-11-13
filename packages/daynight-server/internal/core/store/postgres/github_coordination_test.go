package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"net"
)

func b2Configure(t *testing.T, s *Store, project string, app, installation, repo int64) {
	t.Helper()
	ctx := t.Context()
	c, err := s.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error {
		dao := sc.GitHubDAO()
		if _, err := dao.Connection(ctx); err != nil {
			return err
		}
		ok, err := dao.SaveConfiguration(ctx, store.GitHubConfigurationWrite{ExpectedVersion: 1, Version: 2, Generation: 1, Revision: 1, Enabled: true, AppID: &app, InstallationID: &installation, RepositoryID: &repo, PollIntervalMinutes: 5, AccessState: "available"})
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("configuration refused")
		}
		return nil
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("configure: %+v %v", c, err)
	}
}

func b2Write(t *testing.T, s *Store, project string, fn func(context.Context, store.GitHubWriteDAO) error) {
	t.Helper()
	ctx := t.Context()
	completion, err := s.WriteProject(ctx, project, func(sc store.ProjectWriteScope) error { return fn(ctx, sc.GitHubDAO()) })
	if err != nil || completion.Outcome != store.TransactionCommitted {
		var pgErr *pgconn.PgError
		errors.As(err, &pgErr)
		t.Fatalf("project write: %+v %v postgres=%+v", completion, err, pgErr)
	}
}

func b2Observation(number int64, seen *string) githubpr.PullRequest {
	now := time.Now().UTC().Truncate(time.Microsecond)
	body := "original\nmarkdown"
	return githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: number, GitHubID: number + 100, URL: "https://example.test/pr", Title: "observed", State: "open", BaseRef: "main", HeadSHA: "sha", GitHubCreatedAt: now, GitHubUpdatedAt: now, ObservedAt: now, SeenPollID: seen}, Description: &body}
}

func TestGitHubCoordinationClaimPublicationAndTakeover(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	secondPool, err := pgxpool.NewWithConfig(t.Context(), s.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(secondPool.Close)
	secondInstance := &Store{Pool: secondPool}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	token1, token2 := uuid.NewString(), uuid.NewString()
	firstAcquired := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		completion, err := s.WriteProject(ctx, project.ID, func(sc store.ProjectWriteScope) error {
			ok, err := sc.GitHubDAO().Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token1, Kind: "poll", Until: time.Now().Add(5 * time.Minute)})
			if err != nil || !ok {
				return fmt.Errorf("first claim: %t %v", ok, err)
			}
			close(firstAcquired)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("first completion: %+v", completion)
		}
		firstDone <- err
	}()
	select {
	case <-firstAcquired:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	secondDone := make(chan error, 1)
	go func() {
		completion, err := secondInstance.WriteProject(ctx, project.ID, func(sc store.ProjectWriteScope) error {
			ok, err := sc.GitHubDAO().Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token2, Kind: "poll", Until: time.Now().Add(5 * time.Minute)})
			if err != nil {
				return err
			}
			if ok {
				return errors.New("second instance acquired live claim")
			}
			return nil
		})
		if err == nil && completion.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("second completion: %+v", completion)
		}
		secondDone <- err
	}()
	waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE id =")
	close(release)
	if err := receiveQueryResult(t, ctx, firstDone); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, secondDone); err != nil {
		t.Fatal(err)
	}
	var claimRevision int64
	if err := s.Pool.QueryRow(ctx, `SELECT revision FROM project_github WHERE project_id=$1`, project.ID).Scan(&claimRevision); err != nil || claimRevision != 2 {
		t.Fatalf("claim revision: %d %v", claimRevision, err)
	}
	lease1 := store.GitHubLease{Generation: 1, Token: token1}
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		now, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.Renew(ctx, lease1, now.Add(5*time.Minute))
		if err != nil || !ok {
			return fmt.Errorf("renew: %t %v", ok, err)
		}
		ok, err = dao.Publish(ctx, lease1, []githubpr.PullRequest{b2Observation(1, &token1), b2Observation(2, nil)})
		if err != nil || !ok {
			return fmt.Errorf("publish: %t %v", ok, err)
		}
		unseen, valid, err := dao.UnseenActive(ctx, lease1, token1, 0, 10)
		if err != nil || !valid || !reflect.DeepEqual(unseen, []int64{2}) {
			return fmt.Errorf("unseen: %v valid=%t %v", unseen, valid, err)
		}
		return nil
	})
	mustQueryExec(t, s, `UPDATE project_github SET claim_until=clock_timestamp()-interval '1 second' WHERE project_id=$1`, project.ID)
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		now, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.Renew(ctx, lease1, now.Add(5*time.Minute))
		if err != nil || ok {
			return fmt.Errorf("expired renew: %t %v", ok, err)
		}
		ok, err = dao.Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token2, Kind: "poll", Until: now.Add(5 * time.Minute)})
		if err != nil || !ok {
			return fmt.Errorf("takeover: %t %v", ok, err)
		}
		ok, err = dao.Publish(ctx, lease1, []githubpr.PullRequest{b2Observation(3, &token1)})
		if err != nil || ok {
			return fmt.Errorf("stale publication: %t %v", ok, err)
		}
		return nil
	})
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_requests WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("stale publication persisted: count=%d %v", count, err)
	}
}

func b2Signal(t *testing.T, s *Store, signal store.GitHubPRSignal) int64 {
	t.Helper()
	var count int64
	ctx := t.Context()
	completion, err := s.WriteGitHubSignals(ctx, func(w store.GitHubSignalWriter) error {
		var err error
		count, err = w.SignalPullRequest(ctx, signal)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("signal: %+v %v", completion, err)
	}
	return count
}

func TestGitHubCoordinationSignalsAndConditionalAcknowledgement(t *testing.T) {
	s := isolatedStore(t)
	a, b, other := queryProject(t, s, 1), queryProject(t, s, 2), queryProject(t, s, 3)
	b2Configure(t, s, a.ID, 10, 20, 30)
	b2Configure(t, s, b.ID, 10, 20, 30)
	b2Configure(t, s, other.ID, 10, 20, 31)
	now := time.Now().UTC().Truncate(time.Microsecond)
	request1, request2 := uuid.NewString(), uuid.NewString()
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: request1, DeliveryID: "delivery-1", ReceivedAt: now, NextAttemptAt: now}
	if got := b2Signal(t, s, signal); got != 2 {
		t.Fatalf("matched projects: %d", got)
	}
	token := uuid.NewString()
	lease := store.GitHubLease{Generation: 1, Token: token}
	b2Write(t, s, a.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		clock, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token, Kind: "webhook", Until: clock.Add(5 * time.Minute)})
		if err != nil || !ok {
			return fmt.Errorf("claim: %t %v", ok, err)
		}
		pending, valid, err := dao.Pending(ctx, lease, clock.Add(time.Second), 100)
		if err != nil || !valid || len(pending) != 1 || pending[0].RequestID != request1 {
			return fmt.Errorf("capture: %+v %t %v", pending, valid, err)
		}
		return nil
	})
	signal.RequestID, signal.DeliveryID = request2, "delivery-2"
	if got := b2Signal(t, s, signal); got != 2 {
		t.Fatalf("replacement matches: %d", got)
	}
	b2Write(t, s, a.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		ok, err := dao.Publish(ctx, lease, []githubpr.PullRequest{b2Observation(7, nil)})
		if err != nil || !ok {
			return fmt.Errorf("publish: %t %v", ok, err)
		}
		ok, err = dao.AckPending(ctx, lease, 7, request1)
		if err != nil || ok {
			return fmt.Errorf("old ack: %t %v", ok, err)
		}
		return nil
	})
	var gotA, gotB string
	if err := s.Pool.QueryRow(t.Context(), `SELECT request_id::text FROM project_github_pending_prs WHERE project_id=$1 AND number=7`, a.ID).Scan(&gotA); err != nil {
		t.Fatal(err)
	}
	if err := s.Pool.QueryRow(t.Context(), `SELECT request_id::text FROM project_github_pending_prs WHERE project_id=$1 AND number=7`, b.ID).Scan(&gotB); err != nil {
		t.Fatal(err)
	}
	if gotA != request2 || gotB != request2 {
		t.Fatalf("replacement was lost: %s %s", gotA, gotB)
	}
	var others int
	if err := s.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, other.ID).Scan(&others); err != nil || others != 0 {
		t.Fatalf("different repository: %d %v", others, err)
	}
	b2Write(t, s, a.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		ok, err := dao.AckPending(ctx, lease, 7, request2)
		if err != nil || !ok {
			return fmt.Errorf("current ack: %t %v", ok, err)
		}
		return nil
	})
	var remain int
	if err := s.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, b.ID).Scan(&remain); err != nil || remain != 1 {
		t.Fatalf("cross project ack: %d %v", remain, err)
	}

	sentinel := errors.New("abort broadcast")
	signal.Number, signal.RequestID = 8, uuid.NewString()
	completion, err := s.WriteGitHubSignals(t.Context(), func(w store.GitHubSignalWriter) error {
		if _, err := w.SignalPullRequest(t.Context(), signal); err != nil {
			return err
		}
		return sentinel
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("signal rollback: %+v %v", completion, err)
	}
	if err := s.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE number=8`).Scan(&remain); err != nil || remain != 0 {
		t.Fatalf("rolled back hints: %d %v", remain, err)
	}

	hint := uuid.NewString()
	completion, err = s.WriteGitHubSignals(t.Context(), func(w store.GitHubSignalWriter) error {
		n, err := w.SignalAccess(t.Context(), store.GitHubAccessSignal{AppID: 10, InstallationID: 20, HintID: hint, DeliveryID: "access", ReceivedAt: now})
		if err != nil || n != 3 {
			return fmt.Errorf("access routing: %d %v", n, err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("access signal: %+v %v", completion, err)
	}
	b2Write(t, s, a.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		ok, err := dao.Publish(ctx, lease, []githubpr.PullRequest{b2Observation(9, nil)})
		if err != nil || ok {
			return fmt.Errorf("invalidated claim: %t %v", ok, err)
		}
		return nil
	})
}

func TestGitHubCoordinationDeletionSerializesWithPublication(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	now := time.Now().UTC()
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now}
	if got := b2Signal(t, s, signal); got != 1 {
		t.Fatalf("signal count: %d", got)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	token := uuid.NewString()
	lease := store.GitHubLease{Generation: 1, Token: token}
	entered := make(chan struct{})
	release := make(chan struct{})
	published := make(chan error, 1)
	go func() {
		c, err := s.WriteProject(ctx, project.ID, func(sc store.ProjectWriteScope) error {
			dao := sc.GitHubDAO()
			clock, err := dao.ObservedAt(ctx)
			if err != nil {
				return err
			}
			ok, err := dao.Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token, Kind: "poll", Until: clock.Add(5 * time.Minute)})
			if err != nil || !ok {
				return fmt.Errorf("claim: %t %v", ok, err)
			}
			ok, err = dao.Publish(ctx, lease, []githubpr.PullRequest{b2Observation(7, &token)})
			if err != nil || !ok {
				return fmt.Errorf("publish: %t %v", ok, err)
			}
			close(entered)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if err == nil && c.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("publication completion: %+v", c)
		}
		published <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	deleted := make(chan error, 1)
	go func() {
		c, err := s.WriteProjectDeletion(ctx, project.ID, func(sc store.ProjectDeletionScope) error {
			ok, err := sc.ProjectDAO().MarkDeleted(ctx)
			if err != nil || !ok {
				return fmt.Errorf("mark deleted: %t %v", ok, err)
			}
			return nil
		})
		if err == nil && c.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("deletion completion: %+v", c)
		}
		deleted <- err
	}()
	waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
	close(release)
	if err := receiveQueryResult(t, ctx, published); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, deleted); err != nil {
		t.Fatal(err)
	}
	called := false
	c, err := s.WriteProject(ctx, project.ID, func(sc store.ProjectWriteScope) error { called = true; return nil })
	if c.Outcome != store.TransactionNotCommitted || !errors.Is(err, model.ErrNotFound) || called {
		t.Fatalf("deleted Project write: %+v called=%t %v", c, called, err)
	}
	if got := b2Signal(t, s, signal); got != 0 {
		t.Fatalf("deleted Project accepted signal: %d", got)
	}
	var enabled bool
	var claim *string
	var next *time.Time
	var pending, retained int
	if err := s.Pool.QueryRow(ctx, `SELECT enabled,claim_token::text,next_poll_at,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1),(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project.ID).Scan(&enabled, &claim, &next, &pending, &retained); err != nil {
		t.Fatal(err)
	}
	if enabled || claim != nil || next != nil || pending != 0 || retained != 1 {
		t.Fatalf("deletion state: enabled=%t claim=%v next=%v pending=%d retained=%d", enabled, claim, next, pending, retained)
	}
}

func TestGitHubCoordinationPublicationAndAckRollbackAndUnknown(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	now := time.Now().UTC()
	request, token := uuid.NewString(), uuid.NewString()
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: request, DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now}
	if n := b2Signal(t, s, signal); n != 1 {
		t.Fatalf("signal count: %d", n)
	}
	lease := store.GitHubLease{Generation: 1, Token: token}
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		clock, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token, Kind: "webhook", Until: clock.Add(5 * time.Minute)})
		if err != nil || !ok {
			return fmt.Errorf("claim: %t %v", ok, err)
		}
		return nil
	})
	publishAck := func(ctx context.Context, sc store.ProjectWriteScope) error {
		dao := sc.GitHubDAO()
		ok, err := dao.Publish(ctx, lease, []githubpr.PullRequest{b2Observation(7, nil)})
		if err != nil || !ok {
			return fmt.Errorf("publish: %t %v", ok, err)
		}
		ok, err = dao.AckPending(ctx, lease, 7, request)
		if err != nil || !ok {
			return fmt.Errorf("ack: %t %v", ok, err)
		}
		return nil
	}
	sentinel := errors.New("abort after publication and ack")
	completion, err := s.WriteProject(t.Context(), project.ID, func(sc store.ProjectWriteScope) error {
		if err := publishAck(t.Context(), sc); err != nil {
			return err
		}
		return sentinel
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, sentinel) {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var prs, pending int
	var revision int64
	if err := s.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM project_pull_requests WHERE project_id=$1),(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1),revision FROM project_github WHERE project_id=$1`, project.ID).Scan(&prs, &pending, &revision); err != nil || prs != 0 || pending != 1 || revision != 3 {
		t.Fatalf("rolled back data: prs=%d pending=%d revision=%d %v", prs, pending, revision, err)
	}

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
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	armed.Store(true)
	completion, err = (&Store{Pool: pool}).WriteProject(t.Context(), project.ID, func(sc store.ProjectWriteScope) error { return publishAck(t.Context(), sc) })
	var txErr *store.TransactionError
	if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &txErr) || txErr.Phase != "commit" || !txErr.CommitAttempted || txErr.Outcome != store.TransactionUnknown {
		t.Fatalf("lost confirmation: lost=%t completion=%+v transaction=%+v error=%v", lost.Load(), completion, txErr, err)
	}
	if err := s.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM project_pull_requests WHERE project_id=$1),(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1),revision FROM project_github WHERE project_id=$1`, project.ID).Scan(&prs, &pending, &revision); err != nil || prs != 1 || pending != 0 || revision != 4 {
		t.Fatalf("durable unknown result: prs=%d pending=%d revision=%d %v", prs, pending, revision, err)
	}
}

func TestGitHubCoordinationDisconnectInvalidatesLeaseAndPending(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	now := time.Now().UTC()
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now}
	if n := b2Signal(t, s, signal); n != 1 {
		t.Fatalf("signal count: %d", n)
	}
	token := uuid.NewString()
	lease := store.GitHubLease{Generation: 1, Token: token}
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		clock, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token, Kind: "poll", Until: clock.Add(5 * time.Minute)})
		if err != nil || !ok {
			return fmt.Errorf("claim: %t %v", ok, err)
		}
		ok, err = dao.Publish(ctx, lease, []githubpr.PullRequest{b2Observation(7, &token)})
		if err != nil || !ok {
			return fmt.Errorf("publish: %t %v", ok, err)
		}
		return nil
	})
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		c, err := dao.Connection(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.SaveConfiguration(ctx, store.GitHubConfigurationWrite{ExpectedVersion: c.Version, Version: c.Version + 1, Generation: c.Generation + 1, Revision: c.Revision + 1, Enabled: false, AppID: c.AppID, InstallationID: c.InstallationID, RepositoryID: c.RepositoryID, PollIntervalMinutes: c.PollIntervalMinutes, AccessState: c.AccessState})
		if err != nil || !ok {
			return fmt.Errorf("disconnect: %t %v", ok, err)
		}
		return nil
	})
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		ok, err := dao.Publish(ctx, lease, []githubpr.PullRequest{b2Observation(8, &token)})
		if err != nil || ok {
			return fmt.Errorf("post-disconnect publication: %t %v", ok, err)
		}
		return nil
	})
	if n := b2Signal(t, s, signal); n != 0 {
		t.Fatalf("disconnected signal: %d", n)
	}
	var pending, retained int
	var claim *string
	if err := s.Pool.QueryRow(t.Context(), `SELECT claim_token::text,(SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1),(SELECT count(*) FROM project_pull_requests WHERE project_id=$1) FROM project_github WHERE project_id=$1`, project.ID).Scan(&claim, &pending, &retained); err != nil || claim != nil || pending != 0 || retained != 1 {
		t.Fatalf("disconnect state: claim=%v pending=%d retained=%d %v", claim, pending, retained, err)
	}
}

func TestGitHubCoordinationSignalWaitsForDisconnect(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	locked := make(chan struct{})
	release := make(chan struct{})
	disconnected := make(chan error, 1)
	go func() {
		c, err := s.WriteProject(ctx, project.ID, func(sc store.ProjectWriteScope) error {
			dao := sc.GitHubDAO()
			current, err := dao.Connection(ctx)
			if err != nil {
				return err
			}
			close(locked)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			ok, err := dao.SaveConfiguration(ctx, store.GitHubConfigurationWrite{ExpectedVersion: current.Version, Version: current.Version + 1, Generation: current.Generation + 1, Revision: current.Revision + 1, Enabled: false, AppID: current.AppID, InstallationID: current.InstallationID, RepositoryID: current.RepositoryID, PollIntervalMinutes: current.PollIntervalMinutes, AccessState: current.AccessState})
			if err != nil || !ok {
				return fmt.Errorf("disconnect: %t %v", ok, err)
			}
			return nil
		})
		if err == nil && c.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("disconnect completion: %+v", c)
		}
		disconnected <- err
	}()
	select {
	case <-locked:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	observed := make(chan error, 1)
	go func() {
		now := time.Now().UTC()
		c, err := s.WriteGitHubSignals(ctx, func(w store.GitHubSignalWriter) error {
			n, err := w.SignalPullRequest(ctx, store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now})
			if err != nil || n != 0 {
				return fmt.Errorf("signal after disconnect: %d %v", n, err)
			}
			return nil
		})
		if err == nil && c.Outcome != store.TransactionCommitted {
			err = fmt.Errorf("signal completion: %+v", c)
		}
		observed <- err
	}()
	waitForQueryLock(t, s, "WITH locked AS MATERIALIZED")
	close(release)
	if err := receiveQueryResult(t, ctx, disconnected); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, observed); err != nil {
		t.Fatal(err)
	}
	var pending int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, project.ID).Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("pending after disconnect: %d %v", pending, err)
	}
}

func TestGitHubCoordinationDueProjects(t *testing.T) {
	s := isolatedStore(t)
	a, b, c, blocked := queryProject(t, s, 1), queryProject(t, s, 2), queryProject(t, s, 3), queryProject(t, s, 4)
	for _, id := range []string{a.ID, b.ID, c.ID, blocked.ID} {
		b2Configure(t, s, id, 10, 20, 30)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	signal := store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "delivery", ReceivedAt: now.Add(-5 * time.Minute), NextAttemptAt: now.Add(-5 * time.Minute)}
	if n := b2Signal(t, s, signal); n != 4 {
		t.Fatalf("signal count: %d", n)
	}
	mustQueryExec(t, s, `UPDATE project_github SET next_access_check_at=$2, next_poll_at=$3 WHERE project_id=$1`, a.ID, now.Add(-time.Minute), now.Add(-3*time.Minute))
	mustQueryExec(t, s, `UPDATE project_github SET next_poll_at=$2 WHERE project_id=$1`, b.ID, now.Add(-2*time.Minute))
	mustQueryExec(t, s, `UPDATE project_github SET claim_token=$2, claim_kind='poll', claim_until=$3 WHERE project_id=$1`, blocked.ID, uuid.NewString(), now.Add(time.Minute))
	got, err := s.DueGitHubProjects(t.Context(), 10, now, 10)
	if err != nil || !reflect.DeepEqual(got, []string{a.ID, b.ID, c.ID}) {
		t.Fatalf("due priority and order: %v %v", got, err)
	}
	got, err = s.DueGitHubProjects(t.Context(), 10, now, 2)
	if err != nil || !reflect.DeepEqual(got, []string{a.ID, b.ID}) {
		t.Fatalf("due limit: %v %v", got, err)
	}
	got, err = s.DueGitHubProjects(t.Context(), 999, now, 10)
	if err != nil || len(got) != 3 {
		t.Fatalf("changed app candidates: %v %v", got, err)
	}
	mustQueryExec(t, s, `UPDATE project_github SET access_state='unavailable',access_reason='app_changed' WHERE project_id=$1`, a.ID)
	mustQueryExec(t, s, `UPDATE project_github SET access_state='unavailable',access_reason='installation_missing' WHERE project_id=$1`, b.ID)
	got, err = s.DueGitHubProjects(t.Context(), 10, now, 10)
	if err != nil || !reflect.DeepEqual(got, []string{c.ID}) {
		t.Fatalf("terminal access states must not starve runnable projects: %v %v", got, err)
	}
	got, err = s.DueGitHubProjects(t.Context(), 999, now, 10)
	if err != nil || len(got) != 2 {
		t.Fatalf("changed app must recheck installation-missing bindings: %v %v", got, err)
	}
}

func TestGitHubAccessHintRetryAndNewSignalWake(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	now := time.Now().UTC().Truncate(time.Microsecond)
	initialHint, nextHint := uuid.NewString(), uuid.NewString()
	if n := b2Signal(t, s, store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: "pr", ReceivedAt: now, NextAttemptAt: now}); n != 1 {
		t.Fatalf("PR signal count: %d", n)
	}
	mustQueryExec(t, s, `UPDATE project_github SET access_hint_id=$2,next_access_check_at=$3,next_poll_at=$4 WHERE project_id=$1`, project.ID, initialHint, now.Add(time.Minute), now)
	got, err := s.DueGitHubProjects(t.Context(), 10, now, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("future access retry must block poll and PR: %v %v", got, err)
	}
	got, err = s.DueGitHubProjects(t.Context(), 10, now.Add(time.Minute), 10)
	if err != nil || !reflect.DeepEqual(got, []string{project.ID}) {
		t.Fatalf("access retry due: %v %v", got, err)
	}
	limit := now.Add(30 * time.Second)
	mustQueryExec(t, s, `UPDATE project_github SET not_before=$2 WHERE project_id=$1`, project.ID, limit)
	completion, err := s.WriteGitHubSignals(t.Context(), func(w store.GitHubSignalWriter) error {
		n, e := w.SignalAccess(t.Context(), store.GitHubAccessSignal{AppID: 10, InstallationID: 20, HintID: nextHint, DeliveryID: "new", ReceivedAt: now})
		if e != nil || n != 1 {
			return fmt.Errorf("access signal: %d %w", n, e)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("access signal: %+v %v", completion, err)
	}
	var actualHint string
	var actualNext, actualLimit time.Time
	if err := s.Pool.QueryRow(t.Context(), `SELECT access_hint_id::text,next_access_check_at,not_before FROM project_github WHERE project_id=$1`, project.ID).Scan(&actualHint, &actualNext, &actualLimit); err != nil {
		t.Fatal(err)
	}
	if actualHint != nextHint || !actualNext.Equal(now) || !actualLimit.Equal(limit) {
		t.Fatalf("new signal state: %s %v %v", actualHint, actualNext, actualLimit)
	}
	got, err = s.DueGitHubProjects(t.Context(), 10, now, 10)
	if err != nil || len(got) != 0 {
		t.Fatalf("rate limit bypassed: %v %v", got, err)
	}
	got, err = s.DueGitHubProjects(t.Context(), 10, limit, 10)
	if err != nil || !reflect.DeepEqual(got, []string{project.ID}) {
		t.Fatalf("new signal not due after limit: %v %v", got, err)
	}
}

func TestGitHubCoordinationRuntimeAndConditionalRetries(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	b2Configure(t, s, project.ID, 10, 20, 30)
	now := time.Now().UTC().Truncate(time.Microsecond)
	hint, request, token := uuid.NewString(), uuid.NewString(), uuid.NewString()
	completion, err := s.WriteGitHubSignals(t.Context(), func(w store.GitHubSignalWriter) error {
		n, err := w.SignalAccess(t.Context(), store.GitHubAccessSignal{AppID: 10, InstallationID: 20, HintID: hint, DeliveryID: "access", ReceivedAt: now})
		if err != nil || n != 1 {
			return fmt.Errorf("access signal: %d %v", n, err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("access signal: %+v %v", completion, err)
	}
	if n := b2Signal(t, s, store.GitHubPRSignal{AppID: 10, InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: request, DeliveryID: "pr", ReceivedAt: now, NextAttemptAt: now}); n != 1 {
		t.Fatalf("PR signal count: %d", n)
	}
	lease := store.GitHubLease{Generation: 1, Token: token}
	b2Write(t, s, project.ID, func(ctx context.Context, dao store.GitHubWriteDAO) error {
		clock, err := dao.ObservedAt(ctx)
		if err != nil {
			return err
		}
		ok, err := dao.Claim(ctx, store.GitHubClaim{AppID: 10, Generation: 1, Token: token, Kind: "access", Until: clock.Add(5 * time.Minute)})
		if err != nil || !ok {
			return fmt.Errorf("claim: %t %v", ok, err)
		}
		ok, err = dao.AckAccessHint(ctx, lease, uuid.NewString())
		if err != nil || ok {
			return fmt.Errorf("stale hint ack: %t %v", ok, err)
		}
		ok, err = dao.AckAccessHint(ctx, lease, hint)
		if err != nil || !ok {
			return fmt.Errorf("access ack: %t %v", ok, err)
		}
		ok, err = dao.ReschedulePending(ctx, lease, 7, uuid.NewString(), now.Add(time.Hour))
		if err != nil || ok {
			return fmt.Errorf("stale reschedule: %t %v", ok, err)
		}
		ok, err = dao.ReschedulePending(ctx, lease, 7, request, now.Add(time.Hour))
		if err != nil || !ok {
			return fmt.Errorf("reschedule: %t %v", ok, err)
		}
		pending, valid, err := dao.HasPending(ctx, lease)
		if err != nil || !valid || !pending {
			return fmt.Errorf("pending: %t valid=%t %v", pending, valid, err)
		}
		due, valid, err := dao.Pending(ctx, lease, now.Add(time.Minute), 10)
		if err != nil || !valid || len(due) != 0 {
			return fmt.Errorf("rescheduled due: %+v valid=%t %v", due, valid, err)
		}
		c, err := dao.Connection(ctx)
		if err != nil {
			return err
		}
		pollCode, pollMessage, webhookCode, webhookMessage := "poll-error", "poll failed", "webhook-error", "webhook failed"
		fullGeneration := int64(1)
		runtime := store.GitHubRuntimeWrite{ExpectedRevision: c.Revision, Revision: c.Revision + 1, AccessState: "available", LastPollAttemptAt: &now, LastFullSuccessAt: &now, LastFullGeneration: &fullGeneration, PollErrorCode: &pollCode, PollErrorMessage: &pollMessage, PollErrorAt: &now, WebhookErrorCode: &webhookCode, WebhookErrorMessage: &webhookMessage, WebhookErrorAt: &now, ReleaseClaim: true}
		ok, err = dao.SaveRuntime(ctx, lease, runtime)
		if err != nil || !ok {
			return fmt.Errorf("runtime: %t %v", ok, err)
		}
		ok, err = dao.SaveRuntime(ctx, lease, runtime)
		if err != nil || ok {
			return fmt.Errorf("released lease runtime: %t %v", ok, err)
		}
		return nil
	})
	var claim, actualHint, pollCode, webhookCode *string
	var pollAt, fullAt, next time.Time
	var revision, generation int64
	if err := s.Pool.QueryRow(t.Context(), `SELECT claim_token::text,access_hint_id::text,poll_error_code,webhook_error_code,last_poll_attempt_at,last_full_success_at,last_full_generation,revision,(SELECT next_attempt_at FROM project_github_pending_prs WHERE project_id=$1 AND number=7) FROM project_github WHERE project_id=$1`, project.ID).Scan(&claim, &actualHint, &pollCode, &webhookCode, &pollAt, &fullAt, &generation, &revision, &next); err != nil {
		t.Fatal(err)
	}
	if claim != nil || actualHint != nil || pollCode == nil || *pollCode != "poll-error" || webhookCode == nil || *webhookCode != "webhook-error" || !pollAt.Equal(now) || !fullAt.Equal(now) || generation != 1 || !next.Equal(now.Add(time.Hour)) {
		t.Fatalf("runtime facts: claim=%v hint=%v poll=%v webhook=%v pollAt=%v fullAt=%v generation=%d revision=%d next=%v", claim, actualHint, pollCode, webhookCode, pollAt, fullAt, generation, revision, next)
	}
}
