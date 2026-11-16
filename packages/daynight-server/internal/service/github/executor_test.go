package github

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

const testProject = "a160b005-1336-40c3-85d8-6ab88517877e"

type pollFixture struct {
	t              *testing.T
	now            time.Time
	connection     githubpr.Connection
	lease          store.GitHubLease
	until          time.Time
	publications   [][]githubpr.PullRequest
	runtimes       []store.GitHubRuntimeWrite
	unseen         []int64
	renews         int
	transactions   int
	unknownPublish bool
	unknownClaim   bool
	unknownRenewAt int
	unknownThis    bool
	lost           bool
	workKind       string
	hints          []store.GitHubPendingPR
	ackMatched     bool
	pendingAfter   bool
	ackRequests    []string
	rescheduled    []string
	db             *executorStore
}

func newPollFixture(t *testing.T) *pollFixture {
	t.Helper()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	app, installation, repo := int64(10), int64(20), int64(30)
	name, login := "owner/repo", "owner"
	f := &pollFixture{t: t, now: now, workKind: "poll", connection: githubpr.Connection{ProjectID: testProject, Enabled: true, SyncEnabled: true, AppID: &app, InstallationID: &installation, RepositoryID: &repo, RepositoryFullName: &name, InstallationAccountLogin: &login, Generation: 7, Revision: 8, AccessState: "available", PollIntervalMinutes: 5, NextPollAt: &now}}
	f.db = &executorStore{t: t}
	f.db.write = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		if id != testProject {
			t.Fatalf("project = %q", id)
		}
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 15*time.Second {
			t.Fatal("transaction deadline missing or too long")
		}
		f.transactions++
		f.unknownThis = false
		locked, timed, published, acked := false, false, false, false
		d := executorWriteDAO{}
		d.connection = func(context.Context) (githubpr.Connection, error) { locked = true; return f.connection, nil }
		d.clock = func(context.Context) (time.Time, error) { timed = true; return f.now, nil }
		d.due = func(_ context.Context, now time.Time) (bool, error) {
			if !locked || !timed || !now.Equal(f.now) {
				t.Fatal("due hints queried without locked connection and database time")
			}
			return f.workKind == "webhook", nil
		}
		d.claim = func(_ context.Context, c store.GitHubClaim) (bool, error) {
			if !locked || !timed || c.AppID != 10 || c.Generation != 7 || c.Kind != f.workKind || c.Token == "" || !c.Until.Equal(f.now.Add(5*time.Minute)) {
				t.Fatalf("invalid claim: %+v", c)
			}
			f.lease, f.until = store.GitHubLease{Generation: c.Generation, Token: c.Token}, c.Until
			f.unknownThis = f.unknownClaim
			return true, nil
		}
		checkLease := func(l store.GitHubLease) {
			t.Helper()
			if l != f.lease || l.Token == "" {
				t.Fatalf("incorrect lease: %+v, want %+v", l, f.lease)
			}
		}
		d.renew = func(_ context.Context, l store.GitHubLease, until time.Time) (bool, error) {
			checkLease(l)
			if !locked || !timed || !until.Equal(f.now.Add(5*time.Minute)) {
				t.Fatalf("invalid renewal %s", until)
			}
			f.renews++
			f.unknownThis = f.unknownRenewAt == f.renews
			if f.lost || !f.until.After(f.now) {
				return false, nil
			}
			f.until = until
			return true, nil
		}
		d.repository = func(_ context.Context, l store.GitHubLease, o store.GitHubRepositoryObservation) (bool, error) {
			checkLease(l)
			if o.InstallationID != 20 || o.RepositoryID != 30 || o.RepositoryFullName != "owner/repo" {
				t.Fatalf("repository: %+v", o)
			}
			return !f.lost, nil
		}
		d.publish = func(_ context.Context, l store.GitHubLease, items []githubpr.PullRequest) (bool, error) {
			checkLease(l)
			if len(items) == 0 || len(items) > 25 {
				t.Fatalf("batch size %d", len(items))
			}
			if f.lost {
				return false, nil
			}
			published = true
			f.publications = append(f.publications, append([]githubpr.PullRequest(nil), items...))
			f.unknownThis = f.unknownPublish
			return true, nil
		}
		d.pending = func(_ context.Context, l store.GitHubLease, _ time.Time, n int) ([]store.GitHubPendingPR, bool, error) {
			checkLease(l)
			if n != 1 && n != 100 {
				t.Fatalf("page pending limit %d", n)
			}
			return f.hints, !f.lost, nil
		}
		d.ack = func(_ context.Context, l store.GitHubLease, n int64, request string) (bool, error) {
			checkLease(l)
			if !published || n != 5 {
				t.Fatal("ack was not in publication transaction")
			}
			acked = true
			f.ackRequests = append(f.ackRequests, request)
			return f.ackMatched, nil
		}
		d.hasPending = func(_ context.Context, l store.GitHubLease) (bool, bool, error) {
			checkLease(l)
			if !acked {
				t.Fatal("pending read before conditional ack")
			}
			return f.pendingAfter, !f.lost, nil
		}
		d.reschedule = func(_ context.Context, l store.GitHubLease, n int64, request string, next time.Time) (bool, error) {
			checkLease(l)
			if n != 4 || !locked || !timed || !next.Equal(f.now.Add(30*time.Second)) {
				t.Fatalf("reschedule %d %q %v", n, request, next)
			}
			f.rescheduled = append(f.rescheduled, request)
			return true, nil
		}
		d.unseen = func(_ context.Context, l store.GitHubLease, poll string, after int64, limit int) ([]int64, bool, error) {
			checkLease(l)
			if poll != l.Token || limit != 100 {
				t.Fatalf("unseen poll=%q limit=%d", poll, limit)
			}
			if after == 0 {
				return f.unseen, !f.lost, nil
			}
			return nil, !f.lost, nil
		}
		d.runtime = func(_ context.Context, l store.GitHubLease, w store.GitHubRuntimeWrite) (bool, error) {
			checkLease(l)
			if !locked || !timed || w.ExpectedRevision != 8 {
				t.Fatalf("runtime outside locked scope: %+v", w)
			}
			f.runtimes = append(f.runtimes, w)
			return !f.lost, nil
		}
		err := work(executorWriteScope{dao: d})
		if f.unknownThis {
			return store.Completion{Outcome: store.TransactionUnknown}, errors.New("commit response lost")
		}
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	return f
}

func observation(n int64, state string, now time.Time) githubpr.Observation {
	return githubpr.Observation{Number: n, GitHubID: 1000 + n, URL: fmt.Sprintf("https://github.com/owner/repo/pull/%d", n), Title: fmt.Sprintf("PR %d", n), State: state, BaseRepositoryID: 30, BaseRef: "main", HeadSHA: "sha", CreatedAt: now, UpdatedAt: now}
}

func (f *pollFixture) run(r executorRemote) error {
	f.t.Helper()
	exec, err := NewExecutor(f.db, r, 10, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		f.t.Fatal(err)
	}
	return exec.Execute(context.Background(), testProject)
}

func (f *pollFixture) remote() executorRemote {
	r := executorRemote{}
	r.installation = func(ctx context.Context, id int64) (remote.InstallationStatus, error) {
		if id != 20 {
			f.t.Fatal("wrong installation")
		}
		if err := remote.CheckpointRequest(ctx); err != nil {
			return remote.InstallationStatus{}, err
		}
		return remote.InstallationStatus{ID: id}, nil
	}
	r.verify = func(ctx context.Context, id int64, owner, repo string) (githubpr.RepositoryObservation, error) {
		if id != 20 || owner != "owner" || repo != "repo" {
			f.t.Fatal("wrong access target")
		}
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		return githubpr.RepositoryObservation{ID: 30, FullName: "owner/repo"}, nil
	}
	return r
}

func TestExecutorLongPollReachesTailAndConfirmsAbsences(t *testing.T) {
	f := newPollFixture(t)
	f.unseen = []int64{991, 992}
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		for page := 0; page < 5; page++ {
			f.now = f.now.Add(time.Minute)
			if err := remote.CheckpointRequest(ctx); err != nil {
				return err
			}
			items := make([]githubpr.Observation, 30)
			for i := range items {
				items[i] = observation(int64(page*30+i+1), "open", f.now)
			}
			if err := visit(items); err != nil {
				return err
			}
		}
		return nil
	}
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		o := observation(n, "closed", f.now)
		if n == 992 {
			o.MergedAt = &f.now
		}
		return o, nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if len(f.publications) != 12 || len(f.publications[8]) != 25 || f.publications[9][4].Number != 150 {
		t.Fatalf("tail or finite batches missing: %+v", f.publications)
	}
	if got := f.publications[10][0]; got.Number != 991 || got.State != "closed" || got.SeenPollID != nil {
		t.Fatalf("closed: %+v", got)
	}
	if got := f.publications[11][0]; got.Number != 992 || got.State != "merged" {
		t.Fatalf("merged: %+v", got)
	}
	last := f.runtimes[len(f.runtimes)-1]
	if last.LastFullSuccessAt == nil || !last.LastFullSuccessAt.Equal(f.now) || last.LastFullGeneration == nil || *last.LastFullGeneration != 7 || !last.ReleaseClaim {
		t.Fatalf("poll completion: %+v", last)
	}
	if f.renews < 20 {
		t.Fatalf("missing checkpoints: %d", f.renews)
	}
}

func TestExecutorPartialPollDoesNotComplete(t *testing.T) {
	f := newPollFixture(t)
	want := errors.New("page unavailable")
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		if err := visit([]githubpr.Observation{observation(1, "open", f.now)}); err != nil {
			return err
		}
		return want
	}
	if err := f.run(r); !errors.Is(err, want) {
		t.Fatalf("error = %v", err)
	}
	if len(f.publications) != 1 {
		t.Fatalf("published batches %d", len(f.publications))
	}
	last := f.runtimes[len(f.runtimes)-1]
	if last.LastFullSuccessAt != nil || last.PollErrorCode == nil || last.NextPollAt == nil || !last.NextPollAt.Equal(f.now.Add(30*time.Second)) || !last.ReleaseClaim {
		t.Fatalf("failure result: %+v", last)
	}
}

func TestExecutorUnknownPublicationStopsWithoutSuccess(t *testing.T) {
	f := newPollFixture(t)
	f.unknownPublish = true
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		return visit([]githubpr.Observation{observation(1, "open", f.now)})
	}
	if err := f.run(r); !errors.Is(err, errUnknown) {
		t.Fatalf("error = %v", err)
	}
	if len(f.publications) != 1 || len(f.runtimes) != 1 {
		t.Fatalf("unexpected replay or completion: publications %d runtimes %d", len(f.publications), len(f.runtimes))
	}
}

func TestExecutorOldLeaseCannotPublishLateResponse(t *testing.T) {
	f := newPollFixture(t)
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		// Revocation or takeover occurs after the remote request but before publication.
		f.lost = true
		return visit([]githubpr.Observation{observation(1, "open", f.now)})
	}
	if err := f.run(r); !errors.Is(err, errLease) {
		t.Fatalf("error = %v", err)
	}
	if len(f.publications) != 0 || len(f.runtimes) != 1 {
		t.Fatalf("late write or completion: publications %d runtimes %d", len(f.publications), len(f.runtimes))
	}
}

func TestExecutorPublishesSameSecondHeadChange(t *testing.T) {
	f := newPollFixture(t)
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		for _, sha := range []string{"old", "new"} {
			if err := remote.CheckpointRequest(ctx); err != nil {
				return err
			}
			o := observation(1, "open", f.now)
			o.HeadSHA = sha
			if err := visit([]githubpr.Observation{o}); err != nil {
				return err
			}
		}
		return nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if len(f.publications) != 2 || f.publications[0][0].HeadSHA != "old" || f.publications[1][0].HeadSHA != "new" || !f.publications[0][0].GitHubUpdatedAt.Equal(f.publications[1][0].GitHubUpdatedAt) {
		t.Fatalf("publications: %+v", f.publications)
	}
}

func TestExecutorNewHintSurvivesOlderConditionalAck(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	errorCode := "github_unavailable"
	f.connection.WebhookErrorCode = &errorCode
	f.hints = []store.GitHubPendingPR{{Number: 5, Generation: 7, RequestID: "old-request", DeliveryID: "delivery"}}
	f.pendingAfter = true // The remote read overlaps a replacement signal.
	r := f.remote()
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return observation(n, "open", f.now), nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if len(f.ackRequests) != 1 || f.ackRequests[0] != "old-request" || len(f.publications) != 1 {
		t.Fatalf("hint result: ack=%v publications=%v", f.ackRequests, f.publications)
	}
	var success *store.GitHubRuntimeWrite
	for i := range f.runtimes {
		if f.runtimes[i].LastWebhookSuccessAt != nil {
			success = &f.runtimes[i]
		}
	}
	if success == nil || success.WebhookErrorCode == nil || *success.WebhookErrorCode != errorCode || success.LastFullSuccessAt != nil {
		t.Fatalf("channel state: %+v", success)
	}
}

func TestExecutorAccessLossAndRecovery(t *testing.T) {
	for _, tc := range []struct {
		name       string
		status     remote.InstallationStatus
		installErr error
		wantReason string
		permanent  bool
	}{
		{name: "suspended", status: remote.InstallationStatus{ID: 20, Suspended: true}, wantReason: "suspended"},
		{name: "removed", installErr: &remote.Error{Code: "installation_missing", Status: 404}, wantReason: "installation_missing", permanent: true},
		{name: "repository removed", status: remote.InstallationStatus{ID: 20}, wantReason: "repository_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "access"
			f.connection.NextAccessCheckAt = &f.now
			r := f.remote()
			r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.RepositoryObservation{}, err
				}
				return githubpr.RepositoryObservation{}, &remote.Error{Code: "not_found", Status: 404}
			}
			r.resolve = func(ctx context.Context, _, _ int64) (githubpr.RepositoryObservation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.RepositoryObservation{}, err
				}
				return githubpr.RepositoryObservation{}, &remote.Error{Code: "not_found", Status: 404}
			}
			r.installation = func(ctx context.Context, _ int64) (remote.InstallationStatus, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return remote.InstallationStatus{}, err
				}
				return tc.status, tc.installErr
			}
			if err := f.run(r); !errors.Is(err, errAccessStop) {
				t.Fatalf("error = %v", err)
			}
			w := f.runtimes[len(f.runtimes)-1]
			if w.AccessState != "unavailable" || w.AccessReason == nil || *w.AccessReason != tc.wantReason || w.NextPollAt != nil || !w.ReleaseClaim {
				t.Fatalf("access state: %+v", w)
			}
			if tc.permanent && w.NextAccessCheckAt != nil || !tc.permanent && (w.NextAccessCheckAt == nil || !w.NextAccessCheckAt.Equal(f.now.Add(5*time.Minute))) {
				t.Fatalf("access retry: %+v", w.NextAccessCheckAt)
			}
		})
	}
	t.Run("restored", func(t *testing.T) {
		f := newPollFixture(t)
		f.workKind = "access"
		f.connection.AccessState = "unavailable"
		f.connection.NextAccessCheckAt = &f.now
		if err := f.run(f.remote()); err != nil {
			t.Fatal(err)
		}
		w := f.runtimes[len(f.runtimes)-1]
		if w.AccessState != "available" || w.NextPollAt == nil || !w.NextPollAt.Equal(f.now) || w.NextAccessCheckAt != nil || !w.ReleaseClaim {
			t.Fatalf("recovery: %+v", w)
		}
	})
}

func TestExecutorRateLimitUsesLaterRetry(t *testing.T) {
	f := newPollFixture(t)
	r := f.remote()
	retry := f.now.Add(4 * time.Minute)
	r.list = func(ctx context.Context, _ int64, _, _ string, _ func([]githubpr.Observation) error) error {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		return &remote.Error{Code: "rate_limited", Status: 429, RetryAt: retry}
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected rate limit")
	}
	w := f.runtimes[len(f.runtimes)-1]
	if w.PollErrorCode == nil || *w.PollErrorCode != "github_rate_limited" || w.NextPollAt == nil || !w.NextPollAt.Equal(retry) || w.NotBefore == nil || !w.NotBefore.Equal(retry) || w.LastFullSuccessAt != nil {
		t.Fatalf("rate limit: %+v", w)
	}
}

func TestExecutorUnknownClaimRequiresExactReadback(t *testing.T) {
	for _, mode := range []string{"different-token", "sync-disabled", "matches"} {
		t.Run(mode, func(t *testing.T) {
			f := newPollFixture(t)
			f.unknownClaim = true
			f.db.snapshot = func(ctx context.Context, work func(store.SnapshotScope) error) error {
				observed := f.connection
				token := f.lease.Token
				if mode == "different-token" {
					token = "different-token"
				}
				if mode == "sync-disabled" {
					observed.SyncEnabled = false
				}
				observed.ClaimToken, observed.ClaimUntil = &token, &f.until
				dao := executorReadDAO{connection: func(_ context.Context, id string) (githubpr.Connection, error) {
					if id != testProject {
						t.Fatalf("snapshot project %q", id)
					}
					return observed, nil
				}}
				return work(executorSnapshotScope{dao: dao, clock: func(context.Context) (time.Time, error) { return f.now, nil }})
			}
			r := f.remote()
			r.list = func(ctx context.Context, _ int64, _, _ string, _ func([]githubpr.Observation) error) error {
				return remote.CheckpointRequest(ctx)
			}
			err := f.run(r)
			if mode == "matches" {
				if err != nil {
					t.Fatal(err)
				}
				if len(f.runtimes) != 2 || f.runtimes[1].LastFullSuccessAt == nil {
					t.Fatalf("completion %+v", f.runtimes)
				}
			} else if !errors.Is(err, errUnknown) || len(f.runtimes) != 0 || f.renews != 0 {
				t.Fatalf("unmatched claim continued: error %v runtimes %d renews %d", err, len(f.runtimes), f.renews)
			}
		})
	}
}

func TestExecutorUnknownRenewalStops(t *testing.T) {
	f := newPollFixture(t)
	f.unknownRenewAt = 1
	r := f.remote()
	if err := f.run(r); !errors.Is(err, errUnknown) {
		t.Fatalf("error = %v", err)
	}
	if f.renews != 1 || len(f.publications) != 0 || len(f.runtimes) != 1 {
		t.Fatalf("unknown renewal continued: renews %d publications %d runtimes %d", f.renews, len(f.publications), len(f.runtimes))
	}
}

func TestExecutorContinuesAfterRecoverableHintFailure(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	pollError := "older-poll-failure"
	f.connection.PollErrorCode = &pollError
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "failed"}, {Number: 5, Generation: 7, RequestID: "next"}}
	f.ackMatched = true
	f.pendingAfter = true
	r := f.remote()
	failed := errors.New("temporary remote failure")
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		if n == 4 {
			return githubpr.Observation{}, failed
		}
		return observation(n, "open", f.now), nil
	}
	if err := f.run(r); !errors.Is(err, failed) {
		t.Fatalf("error = %v", err)
	}
	if len(f.rescheduled) != 1 || f.rescheduled[0] != "failed" || len(f.ackRequests) != 1 || f.ackRequests[0] != "next" {
		t.Fatalf("rescheduled=%v ack=%v", f.rescheduled, f.ackRequests)
	}
	for _, w := range f.runtimes {
		if w.PollErrorCode == nil || *w.PollErrorCode != pollError || w.LastFullSuccessAt != nil {
			t.Fatalf("poll channel changed: %+v", w)
		}
	}
}

func TestExecutorNoDueWorkDoesNotClaim(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "none"
	f.connection.NextPollAt = nil
	if err := f.run(executorRemote{}); err != nil {
		t.Fatal(err)
	}
	if f.lease.Token != "" || f.transactions != 1 || len(f.runtimes) != 0 {
		t.Fatalf("unexpected claim or work: %+v", f)
	}
}

func TestExecutorHintFailureRechecksRepositoryAccess(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "failed"}}
	r := f.remote()
	checks := 0
	originalVerify := r.verify
	r.verify = func(ctx context.Context, id int64, owner, repo string) (githubpr.RepositoryObservation, error) {
		checks++
		if checks == 1 {
			return originalVerify(ctx, id, owner, repo)
		}
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		return githubpr.RepositoryObservation{}, &remote.Error{Code: "permission_denied", Status: 403}
	}
	r.pull = func(ctx context.Context, _ int64, _, _ string, _ int64) (githubpr.Observation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return githubpr.Observation{}, &remote.Error{Code: "not_found", Status: 404}
	}
	r.resolve = func(ctx context.Context, _, _ int64) (githubpr.RepositoryObservation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		return githubpr.RepositoryObservation{}, &remote.Error{Code: "permission_denied", Status: 403}
	}
	r.installation = func(ctx context.Context, _ int64) (remote.InstallationStatus, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return remote.InstallationStatus{}, err
		}
		return remote.InstallationStatus{ID: 20, Suspended: true}, nil
	}
	if err := f.run(r); !errors.Is(err, errAccessStop) {
		t.Fatalf("error = %v", err)
	}
	w := f.runtimes[len(f.runtimes)-1]
	if checks != 2 || len(f.rescheduled) != 1 || f.rescheduled[0] != "failed" || len(f.publications) != 0 || w.AccessState != "unavailable" || w.AccessReason == nil || *w.AccessReason != "suspended" || w.WebhookErrorCode == nil || !w.ReleaseClaim {
		t.Fatalf("checks=%d retry=%v state=%+v", checks, f.rescheduled, w)
	}
}
