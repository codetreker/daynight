package github

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type failureScope struct {
	store.ProjectWriteScope
	dao store.GitHubWriteDAO
}

func (s failureScope) GitHubDAO() store.GitHubWriteDAO { return s.dao }

type failureDAO struct {
	store.GitHubWriteDAO
	method    string
	remaining *int
	cause     error
}

func (d failureDAO) fail(method string) error {
	if d.method != method {
		return nil
	}
	*d.remaining--
	if *d.remaining == 0 {
		return d.cause
	}
	return nil
}
func (d failureDAO) Connection(ctx context.Context) (githubpr.Connection, error) {
	if err := d.fail("connection"); err != nil {
		return githubpr.Connection{}, err
	}
	return d.GitHubWriteDAO.Connection(ctx)
}
func (d failureDAO) ObservedAt(ctx context.Context) (time.Time, error) {
	if err := d.fail("clock"); err != nil {
		return time.Time{}, err
	}
	return d.GitHubWriteDAO.ObservedAt(ctx)
}
func (d failureDAO) SaveRuntime(ctx context.Context, l store.GitHubLease, w store.GitHubRuntimeWrite) (bool, error) {
	if err := d.fail("runtime"); err != nil {
		return false, err
	}
	return d.GitHubWriteDAO.SaveRuntime(ctx, l, w)
}
func (d failureDAO) Renew(ctx context.Context, l store.GitHubLease, until time.Time) (bool, error) {
	if err := d.fail("renew"); err != nil {
		return false, err
	}
	return d.GitHubWriteDAO.Renew(ctx, l, until)
}
func (d failureDAO) PublishRepository(ctx context.Context, l store.GitHubLease, o store.GitHubRepositoryObservation) (bool, error) {
	if err := d.fail("repository"); err != nil {
		return false, err
	}
	return d.GitHubWriteDAO.PublishRepository(ctx, l, o)
}
func (d failureDAO) Pending(ctx context.Context, l store.GitHubLease, now time.Time, limit int) ([]store.GitHubPendingPR, bool, error) {
	if err := d.fail("pending"); err != nil {
		return nil, false, err
	}
	return d.GitHubWriteDAO.Pending(ctx, l, now, limit)
}
func (d failureDAO) UnseenActive(ctx context.Context, l store.GitHubLease, poll string, after int64, limit int) ([]int64, bool, error) {
	if err := d.fail("unseen"); err != nil {
		return nil, false, err
	}
	return d.GitHubWriteDAO.UnseenActive(ctx, l, poll, after, limit)
}
func (d failureDAO) AckPending(ctx context.Context, l store.GitHubLease, number int64, request string) (bool, error) {
	if err := d.fail("ack"); err != nil {
		return false, err
	}
	return d.GitHubWriteDAO.AckPending(ctx, l, number, request)
}
func (d failureDAO) HasPending(ctx context.Context, l store.GitHubLease) (bool, bool, error) {
	if err := d.fail("hasPending"); err != nil {
		return false, false, err
	}
	return d.GitHubWriteDAO.HasPending(ctx, l)
}
func (d failureDAO) ReschedulePending(ctx context.Context, l store.GitHubLease, number int64, request string, next time.Time) (bool, error) {
	if err := d.fail("reschedule"); err != nil {
		return false, err
	}
	return d.GitHubWriteDAO.ReschedulePending(ctx, l, number, request, next)
}

func injectFailure(f *pollFixture, method string, nth int, cause error) {
	write := f.db.write
	f.db.write = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return write(ctx, id, func(s store.ProjectWriteScope) error {
			return work(failureScope{ProjectWriteScope: s, dao: failureDAO{GitHubWriteDAO: s.GitHubDAO(), method: method, remaining: &nth, cause: cause}})
		})
	}
}

func TestExecutorDatabaseFailuresStopWork(t *testing.T) {
	for _, tc := range []struct {
		method string
		nth    int
	}{
		{"connection", 1}, {"clock", 1}, {"runtime", 1}, {"renew", 1}, {"repository", 1}, {"unseen", 1},
	} {
		t.Run(tc.method, func(t *testing.T) {
			f := newPollFixture(t)
			cause := errors.New("controlled database error")
			injectFailure(f, tc.method, tc.nth, cause)
			r := f.remote()
			r.list = func(ctx context.Context, _ int64, _, _ string, _ func([]githubpr.Observation) error) error {
				return remote.CheckpointRequest(ctx)
			}
			if err := f.run(r); !errors.Is(err, cause) || !errors.Is(err, errTransaction) {
				t.Fatalf("error = %v", err)
			}
			for _, w := range f.runtimes {
				if w.LastFullSuccessAt != nil {
					t.Fatalf("unexpected success: %+v", w)
				}
			}
			if len(f.publications) != 0 {
				t.Fatal("unexpected publication after failure")
			}
		})
	}
}

func TestExecutorRejectsUnconfirmedAbsentPullRequest(t *testing.T) {
	for _, wrongNumber := range []bool{false, true} {
		t.Run(map[bool]string{false: "not-found", true: "wrong-number"}[wrongNumber], func(t *testing.T) {
			f := newPollFixture(t)
			f.unseen = []int64{99}
			r := f.remote()
			r.list = func(ctx context.Context, _ int64, _, _ string, _ func([]githubpr.Observation) error) error {
				return remote.CheckpointRequest(ctx)
			}
			r.pull = func(ctx context.Context, _ int64, _, _ string, _ int64) (githubpr.Observation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.Observation{}, err
				}
				if wrongNumber {
					return observation(98, "closed", f.now), nil
				}
				return githubpr.Observation{}, &remote.Error{Code: "not_found", Status: 404}
			}
			if err := f.run(r); err == nil {
				t.Fatal("expected incomplete poll")
			}
			if len(f.publications) != 0 {
				t.Fatal("absence was published as a close")
			}
			w := f.runtimes[len(f.runtimes)-1]
			if w.LastFullSuccessAt != nil || w.PollErrorCode == nil || !w.ReleaseClaim {
				t.Fatalf("poll result: %+v", w)
			}
		})
	}
}

func TestExecutorCancellationStopsWithoutCompletion(t *testing.T) {
	f := newPollFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, _ func([]githubpr.Observation) error) error {
		cancel()
		return remote.CheckpointRequest(ctx)
	}
	exec, err := NewExecutor(f.db, r, 10, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err = exec.Execute(ctx, testProject); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if len(f.runtimes) != 1 || len(f.publications) != 0 {
		t.Fatalf("cancellation performed further writes: %+v", f.runtimes)
	}
}

func TestExecutorClosedUnknownHintDoesNotCreateHistory(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 5, Generation: 7, RequestID: "request"}}
	f.db.snapshot = func(ctx context.Context, work func(store.SnapshotScope) error) error {
		dao := executorReadDAO{pull: func(_ context.Context, id string, number int64) (githubpr.PullRequest, error) {
			if id != testProject || number != 5 {
				t.Fatal("wrong lookup")
			}
			return githubpr.PullRequest{}, model.ErrNotFound
		}}
		return work(executorSnapshotScope{dao: dao})
	}
	// This ack belongs to an intentionally unpublished historical PR.
	write := f.db.write
	var acks int
	f.db.write = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return write(ctx, id, func(s store.ProjectWriteScope) error {
			return work(failureScope{ProjectWriteScope: s, dao: skipHistoricalDAO{GitHubWriteDAO: s.GitHubDAO(), acks: &acks}})
		})
	}
	r := f.remote()
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return observation(n, "closed", f.now), nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if len(f.publications) != 0 || acks != 1 {
		t.Fatalf("publications=%d acks=%d", len(f.publications), acks)
	}
}

type skipHistoricalDAO struct {
	store.GitHubWriteDAO
	acks *int
}

func (d skipHistoricalDAO) AckPending(_ context.Context, _ store.GitHubLease, number int64, request string) (bool, error) {
	if number != 5 || request != "request" {
		return false, errors.New("wrong acknowledgement")
	}
	*d.acks++
	return true, nil
}
func (d skipHistoricalDAO) HasPending(context.Context, store.GitHubLease) (bool, bool, error) {
	return false, true, nil
}

func TestExecutorHintTransactionFailuresDoNotReportSuccess(t *testing.T) {
	for _, method := range []string{"pending", "ack", "hasPending"} {
		t.Run(method, func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "webhook"
			f.connection.NextPollAt = nil
			f.hints = []store.GitHubPendingPR{{Number: 5, Generation: 7, RequestID: "request"}}
			f.ackMatched = true
			cause := errors.New("controlled hint transaction failure")
			injectFailure(f, method, 1, cause)
			r := f.remote()
			r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.Observation{}, err
				}
				return observation(n, "open", f.now), nil
			}
			if err := f.run(r); !errors.Is(err, cause) || !errors.Is(err, errTransaction) {
				t.Fatalf("error = %v", err)
			}
			for _, w := range f.runtimes {
				if w.LastWebhookSuccessAt != nil || w.ReleaseClaim {
					t.Fatalf("success or release after failed transaction: %+v", w)
				}
			}
		})
	}
}

func TestExecutorRejectsObservationFromDifferentRepository(t *testing.T) {
	f := newPollFixture(t)
	r := f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		o := observation(1, "open", f.now)
		o.BaseRepositoryID = 31
		return visit([]githubpr.Observation{o})
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected repository identity mismatch")
	}
	if len(f.publications) != 0 {
		t.Fatal("published observation from another repository")
	}
	w := f.runtimes[len(f.runtimes)-1]
	if w.PollErrorCode == nil || w.LastFullSuccessAt != nil || !w.ReleaseClaim {
		t.Fatalf("poll state: %+v", w)
	}
}

func TestExecutorRateLimitedHintStopsRemainingRequests(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "limited"}, {Number: 5, Generation: 7, RequestID: "later"}}
	r := f.remote()
	calls := 0
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		if n != 4 {
			t.Fatal("requested later hint during rate limit")
		}
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return githubpr.Observation{}, &remote.Error{Code: "rate_limited", Status: 429, RetryAt: f.now.Add(30 * time.Second)}
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected rate limit")
	}
	if calls != 1 || len(f.rescheduled) != 1 || f.rescheduled[0] != "limited" {
		t.Fatalf("calls=%d rescheduled=%v", calls, f.rescheduled)
	}
	var recorded bool
	for _, w := range f.runtimes {
		if w.WebhookErrorCode != nil && *w.WebhookErrorCode == "github_rate_limited" && w.NotBefore != nil {
			recorded = true
		}
	}
	if !recorded || !f.runtimes[len(f.runtimes)-1].ReleaseClaim {
		t.Fatalf("rate limit not recorded and released: %+v", f.runtimes)
	}
}

type validLeaseDAO struct{ store.GitHubWriteDAO }

func (d validLeaseDAO) ValidLease(context.Context, store.GitHubLease) (bool, error) {
	return true, nil
}

func TestExecutorReschedulesHintsWhenRepositoryUnavailable(t *testing.T) {
	for _, failReschedule := range []bool{false, true} {
		t.Run(map[bool]string{false: "retry", true: "store failure"}[failReschedule], func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "webhook"
			f.connection.NextPollAt = nil
			f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "request"}}
			cause := errors.New("repository temporarily unavailable")
			storeErr := errors.New("reschedule failed")
			write := f.db.write
			count := 1
			f.db.write = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				return write(ctx, id, func(s store.ProjectWriteScope) error {
					var dao store.GitHubWriteDAO = validLeaseDAO{GitHubWriteDAO: s.GitHubDAO()}
					if failReschedule {
						dao = failureDAO{GitHubWriteDAO: dao, method: "reschedule", remaining: &count, cause: storeErr}
					}
					return work(failureScope{ProjectWriteScope: s, dao: dao})
				})
			}
			r := f.remote()
			r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.RepositoryObservation{}, err
				}
				return githubpr.RepositoryObservation{}, cause
			}
			err := f.run(r)
			if !errors.Is(err, cause) {
				t.Fatalf("error = %v", err)
			}
			if failReschedule {
				if !errors.Is(err, storeErr) || !errors.Is(err, errTransaction) || len(f.runtimes) != 0 {
					t.Fatalf("failed reschedule: %v, runtimes %+v", err, f.runtimes)
				}
			} else {
				if !errors.Is(err, errAccessStop) || len(f.rescheduled) != 1 || f.rescheduled[0] != "request" || len(f.runtimes) != 1 || !f.runtimes[0].ReleaseClaim {
					t.Fatalf("retry: %v, rescheduled %v, runtimes %+v", err, f.rescheduled, f.runtimes)
				}
			}
		})
	}
}

func TestExecutorStopsWhenFailedHintCannotBeRescheduled(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "request"}}
	storeErr := errors.New("retry write failed")
	injectFailure(f, "reschedule", 1, storeErr)
	upstreamErr := errors.New("PR read failed")
	r := f.remote()
	r.pull = func(ctx context.Context, _ int64, _, _ string, _ int64) (githubpr.Observation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return githubpr.Observation{}, upstreamErr
	}
	err := f.run(r)
	if !errors.Is(err, upstreamErr) || !errors.Is(err, storeErr) || !errors.Is(err, errTransaction) {
		t.Fatalf("error = %v", err)
	}
	if len(f.runtimes) != 1 || f.runtimes[0].ReleaseClaim || len(f.publications) != 0 {
		t.Fatalf("unexpected completion: %+v", f.runtimes)
	}
}
