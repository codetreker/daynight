package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func TestDiscoveryAggregatesDuplicatesAndSkipsOutsideCoverage(t *testing.T) {
	f := newPollFixture(t)
	start := f.now.Add(-time.Hour)
	outside := start.Add(-time.Second)
	inside := f.now.Add(-time.Minute)
	f.facts = func(number int64, at *time.Time) store.GitHubPublicationFacts {
		for _, batch := range f.publications {
			for _, p := range batch {
				if p.Number == number {
					return store.GitHubPublicationFacts{Current: &p}
				}
			}
		}
		return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: start}}
	}
	r := f.remote()
	var pulls []int64
	r.listAll = func(ctx context.Context, _, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		if err := visit([]remote.PullSummary{{Number: 1, RepositoryID: 30, State: "closed", UpdatedAt: outside, ClosedAt: &outside}, {Number: 2, RepositoryID: 30, State: "closed", UpdatedAt: outside, ClosedAt: &outside}}); err != nil {
			return false, err
		}
		if err := visit([]remote.PullSummary{{Number: 1, RepositoryID: 30, State: "closed", UpdatedAt: inside, ClosedAt: &inside}}); err != nil {
			return false, err
		}
		return true, nil
	}
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		pulls = append(pulls, n)
		o := observation(n, "closed", inside)
		o.ClosedAt = &inside
		return o, nil
	}
	run := f.preparedRun(r)
	if err := run.discover(context.Background(), "owner", "repo"); err != nil {
		t.Fatal(err)
	}
	if len(pulls) != 1 || pulls[0] != 1 || len(f.publications) != 1 || f.publications[0][0].Number != 1 {
		t.Fatalf("pulls=%v publications=%+v", pulls, f.publications)
	}
}

func TestDiscoveryFailureDoesNotAdvanceFullSuccess(t *testing.T) {
	f := newPollFixture(t)
	r := f.remote()
	r.listAll = func(ctx context.Context, _, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		return false, errors.New("tenth page failed")
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected failure")
	}
	last := f.runtimes[len(f.runtimes)-1]
	if last.LastFullSuccessAt != nil || !last.ReleaseClaim {
		t.Fatalf("failure advanced success: %+v", last)
	}
}

func TestOldClosedDetailCannotUndoConfirmedReopen(t *testing.T) {
	f := newPollFixture(t)
	updated := f.now
	old := updated.Add(-time.Second)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open", GitHubUpdatedAt: updated}}}
	}
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		o := observation(n, "closed", old)
		o.ClosedAt = &old
		return o, nil
	}
	_, err := f.preparedRun(r).checkedDetail(context.Background(), "owner", "repo", 5, nil)
	if err == nil || calls != 2 || len(f.publications) != 0 {
		t.Fatalf("err=%v calls=%d publications=%v", err, calls, f.publications)
	}
}

func TestContradictoryDetailReadIsNotPublished(t *testing.T) {
	f := newPollFixture(t)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts { return store.GitHubPublicationFacts{} }
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		if calls == 1 {
			o := observation(n, "open", f.now)
			return o, nil
		}
		o := observation(n, "closed", f.now)
		o.ClosedAt = &f.now
		return o, nil
	}
	s := remote.PullSummary{Number: 5, RepositoryID: 30, State: "closed", UpdatedAt: f.now, ClosedAt: &f.now}
	_, err := f.preparedRun(r).checkedDetail(context.Background(), "owner", "repo", 5, []remote.PullSummary{s})
	if err == nil || calls != 2 || len(f.publications) != 0 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
}

func TestSameSecondReopenContradictsOldClosedRead(t *testing.T) {
	f := newPollFixture(t)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open", GitHubUpdatedAt: f.now}}}
	}
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		if calls == 1 {
			o := observation(n, "closed", f.now)
			o.ClosedAt = &f.now
			return o, nil
		}
		return observation(n, "open", f.now), nil
	}
	_, err := f.preparedRun(r).checkedDetail(context.Background(), "owner", "repo", 5, nil)
	if err == nil || calls != 2 || len(f.publications) != 0 {
		t.Fatalf("err=%v calls=%d publications=%v", err, calls, f.publications)
	}
}

func TestNewerSummaryTerminalTimeCannotBeDiscarded(t *testing.T) {
	f := newPollFixture(t)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts { return store.GitHubPublicationFacts{} }
	recent := f.now
	old := recent.Add(-time.Hour)
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		o := observation(n, "closed", old)
		o.ClosedAt = &old
		return o, nil
	}
	summary := remote.PullSummary{Number: 5, RepositoryID: 30, State: "closed", UpdatedAt: recent, ClosedAt: &recent}
	_, err := f.preparedRun(r).checkedDetail(context.Background(), "owner", "repo", 5, []remote.PullSummary{summary})
	if err == nil || calls != 2 || len(f.publications) != 0 {
		t.Fatalf("err=%v calls=%d publications=%v", err, calls, f.publications)
	}
}

func TestOldClosedTimeCannotReplaceNewerClosedTime(t *testing.T) {
	f := newPollFixture(t)
	recent := f.now
	old := recent.Add(-time.Hour)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "closed", GitHubUpdatedAt: recent, GitHubClosedAt: &recent}}}
	}
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		o := observation(n, "closed", old)
		o.ClosedAt = &old
		return o, nil
	}
	_, err := f.preparedRun(r).checkedDetail(context.Background(), "owner", "repo", 5, nil)
	if err == nil || calls != 2 || len(f.publications) != 0 {
		t.Fatalf("err=%v calls=%d publications=%v", err, calls, f.publications)
	}
}

func TestInvalidTerminalDetailReschedulesHint(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "invalid-detail"}}
	r := f.remote()
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		o := observation(n, "closed", f.now)
		o.ClosedAt = nil
		return o, nil
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected invalid detail error")
	}
	if len(f.publications) != 0 || len(f.ackRequests) != 0 || len(f.rescheduled) != 1 || f.rescheduled[0] != "invalid-detail" {
		t.Fatalf("publications=%v acks=%v rescheduled=%v", f.publications, f.ackRequests, f.rescheduled)
	}
}

func TestInvalidTerminalDetailDoesNotCompletePoll(t *testing.T) {
	f := newPollFixture(t)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: f.now.Add(-time.Hour)}}
	}
	r := f.remote()
	r.listAll = func(ctx context.Context, _, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		return false, visit([]remote.PullSummary{{Number: 5, RepositoryID: 30, State: "closed", UpdatedAt: f.now, ClosedAt: &f.now}})
	}
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		o := observation(n, "closed", f.now)
		o.ClosedAt = nil
		return o, nil
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected invalid detail error")
	}
	last := f.runtimes[len(f.runtimes)-1]
	if last.LastFullSuccessAt != nil || !last.ReleaseClaim || len(f.publications) != 0 {
		t.Fatalf("runtime=%+v publications=%v", last, f.publications)
	}
}

func TestHintReschedulesWhenConfirmedStateChangesBeforeWrite(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "stale-observation"}}
	old := f.now
	calls := 0
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		calls++
		if calls <= 2 {
			return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: old.Add(-time.Hour)}}
		}
		return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open", GitHubUpdatedAt: f.now}}}
	}
	r := f.remote()
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		o := observation(n, "closed", old)
		return o, nil
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected conflict")
	}
	if len(f.publications) != 0 || len(f.ackRequests) != 0 || len(f.rescheduled) != 1 || f.rescheduled[0] != "stale-observation" {
		t.Fatalf("publications=%v acks=%v rescheduled=%v", f.publications, f.ackRequests, f.rescheduled)
	}
}

func TestHintDoesNotRescheduleUnknownConflictTransaction(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "unknown-conflict"}}
	old := f.now.Add(-time.Hour)
	calls := 0
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		calls++
		if calls <= 2 {
			return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: old.Add(-time.Hour)}}
		}
		return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open", GitHubUpdatedAt: f.now}}}
	}
	write := f.db.write
	f.db.write = func(ctx context.Context, id string, work func(store.GitHubWorkDAO) error) (store.Completion, error) {
		c, err := write(ctx, id, work)
		if errors.Is(err, errObservationConflict) {
			return store.Completion{Outcome: store.TransactionUnknown}, err
		}
		return c, err
	}
	r := f.remote()
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		return observation(n, "closed", old), nil
	}
	if err := f.run(r); !errors.Is(err, errUnknown) {
		t.Fatalf("expected unknown outcome: %v", err)
	}
	if len(f.rescheduled) != 0 || len(f.ackRequests) != 0 {
		t.Fatalf("rescheduled=%v acks=%v", f.rescheduled, f.ackRequests)
	}
}

func TestCoveredTerminalHintPublishesAndAcknowledgesTogether(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 5, Generation: 7, RequestID: "covered-terminal"}}
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: f.now.Add(-time.Hour)}}
	}
	r := f.remote()
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		o := observation(n, "closed", f.now)
		o.MergedAt = &f.now
		return o, nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if len(f.publications) != 1 || f.publications[0][0].State != "merged" || len(f.ackRequests) != 1 || f.ackRequests[0] != "covered-terminal" {
		t.Fatalf("publications=%v acks=%v", f.publications, f.ackRequests)
	}
}

func TestPollBackfillsTerminalRequestsAndLaterVisibleNumber(t *testing.T) {
	f := newPollFixture(t)
	start := f.now.Add(-time.Hour)
	terminal := f.now.Add(-time.Minute)
	body := "**original markdown**"
	f.unseen = []int64{9}
	f.facts = func(number int64, _ *time.Time) store.GitHubPublicationFacts {
		for i := len(f.publications) - 1; i >= 0; i-- {
			for _, p := range f.publications[i] {
				if p.Number == number {
					v := p
					return store.GitHubPublicationFacts{Current: &v}
				}
			}
		}
		if number == 8 || number == 9 {
			return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: number, State: "open"}}}
		}
		return store.GitHubPublicationFacts{Period: &store.GitHubCoveragePeriod{StartedAt: start}}
	}
	r := f.remote()
	round := 1
	pages, openPages := 0, 0
	pulls := []int64{}
	r.listAll = func(ctx context.Context, _, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		for page := 0; page < 10; page++ {
			pages++
			if err := remote.CheckpointRequest(ctx); err != nil {
				return false, err
			}
			var list []remote.PullSummary
			if page == 0 {
				if round == 1 {
					list = []remote.PullSummary{{Number: 1, RepositoryID: 30, State: "closed", UpdatedAt: terminal, ClosedAt: &terminal}, {Number: 2, RepositoryID: 30, State: "closed", UpdatedAt: terminal, ClosedAt: &terminal, MergedAt: &terminal}}
				} else {
					list = []remote.PullSummary{{Number: 3, RepositoryID: 30, State: "closed", UpdatedAt: terminal, ClosedAt: &terminal}}
				}
			}
			if page == 1 && round == 1 {
				list = []remote.PullSummary{{Number: 1, RepositoryID: 30, State: "closed", UpdatedAt: terminal, ClosedAt: &terminal}}
			}
			if err := visit(list); err != nil {
				return false, err
			}
		}
		return true, nil
	}
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		openPages++
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		return visit([]githubpr.Observation{observation(8, "open", f.now)})
	}
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		pulls = append(pulls, n)
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		o := observation(n, "closed", terminal)
		o.Description = &body
		if n == 2 {
			o.MergedAt = &terminal
		}
		return o, nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if pages != 10 || openPages != 1 || len(pulls) != 3 || pulls[0] != 1 || pulls[1] != 2 || pulls[2] != 9 {
		t.Fatalf("pages=%d open=%d detail=%v", pages, openPages, pulls)
	}
	found := map[int64]githubpr.PullRequest{}
	for _, batch := range f.publications {
		for _, p := range batch {
			found[p.Number] = p
		}
	}
	for _, n := range []int64{1, 2, 9} {
		p, ok := found[n]
		if !ok || p.Description == nil || *p.Description != body || p.GitHubClosedAt == nil || !p.GitHubClosedAt.Equal(terminal) {
			t.Fatalf("missing terminal %d: %+v", n, p)
		}
	}
	if found[1].State != "closed" || found[2].State != "merged" || found[2].GitHubMergedAt == nil || found[8].State != "open" {
		t.Fatalf("wrong states: %+v", found)
	}
	if len(f.runtimes) == 0 || f.runtimes[len(f.runtimes)-1].LastFullSuccessAt == nil {
		t.Fatalf("no full success: %+v", f.runtimes)
	}
	round = 2
	f.unseen = nil
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if pages != 20 || openPages != 2 || len(pulls) != 4 || pulls[3] != 3 {
		t.Fatalf("pages=%d open=%d detail=%v", pages, openPages, pulls)
	}
	found3 := false
	for _, batch := range f.publications {
		for _, p := range batch {
			if p.Number == 3 && p.State == "closed" {
				found3 = true
			}
		}
	}
	if !found3 {
		t.Fatal("later visible candidate missing")
	}
}

func TestPollRateLimitPreservesSuccessAndRecoversDiscovery(t *testing.T) {
	f := newPollFixture(t)
	oldSuccess := f.now.Add(-time.Hour)
	f.connection.LastFullSuccessAt = &oldSuccess
	retry := f.now.Add(10 * time.Minute)
	r := f.remote()
	fail := true
	requests := 0
	r.listAll = func(ctx context.Context, _, _ int64, _, _ string, visit func([]remote.PullSummary) error) (bool, error) {
		requests++
		if fail {
			return false, &remote.Error{Code: "rate_limited", Status: 429, RetryAt: retry}
		}
		return false, visit(nil)
	}
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		return visit(nil)
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected limit")
	}
	failed := f.runtimes[len(f.runtimes)-1]
	if failed.LastFullSuccessAt == nil || !failed.LastFullSuccessAt.Equal(oldSuccess) || failed.NotBefore == nil || failed.NotBefore.Before(retry) {
		t.Fatalf("limit runtime=%+v", failed)
	}
	fail = false
	f.now = retry
	f.lease = store.GitHubLease{}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	success := f.runtimes[len(f.runtimes)-1]
	if requests != 2 || success.LastFullSuccessAt == nil || !success.LastFullSuccessAt.Equal(retry) {
		t.Fatalf("requests=%d success=%+v", requests, success)
	}
}

func TestSameSecondMergedDetailAdvancesConfirmedOpen(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 5, Generation: 7, RequestID: "same-second-merge"}}
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		return store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open", GitHubUpdatedAt: f.now}}}
	}
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		o := observation(n, "closed", f.now)
		o.MergedAt = &f.now
		return o, nil
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(f.publications) != 1 || f.publications[0][0].State != "merged" || len(f.ackRequests) != 1 {
		t.Fatalf("calls=%d publications=%v acks=%v", calls, f.publications, f.ackRequests)
	}
}

func TestSameSecondTransitionsUseStableCurrentDetail(t *testing.T) {
	for _, state := range []string{"open", "closed"} {
		t.Run(state, func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "webhook"
			f.connection.NextPollAt = nil
			f.hints = []store.GitHubPendingPR{{Number: 5, Generation: 7, RequestID: "same-second-transition"}}
			oldState := "closed"
			if state == "closed" {
				oldState = "open"
			}
			prior := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: oldState, GitHubUpdatedAt: f.now}}
			if oldState == "closed" {
				prior.GitHubClosedAt = &f.now
			}
			f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
				return store.GitHubPublicationFacts{Current: &prior}
			}
			r := f.remote()
			calls := 0
			r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
				calls++
				return observation(n, state, f.now), nil
			}
			if err := f.run(r); err != nil {
				t.Fatal(err)
			}
			if calls != 2 || len(f.publications) != 1 || f.publications[0][0].State != state || len(f.ackRequests) != 1 {
				t.Fatalf("calls=%d publications=%v acks=%v", calls, f.publications, f.ackRequests)
			}
		})
	}
}

func TestConfirmedStateChangeDuringReadRejectsLateDetail(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "late-delivery"}}
	current := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "closed", GitHubUpdatedAt: f.now, GitHubClosedAt: &f.now}}
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		copy := current
		return store.GitHubPublicationFacts{Current: &copy}
	}
	r := f.remote()
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		old := observation(n, "closed", f.now)
		current = githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open", GitHubUpdatedAt: f.now, ObservedAt: f.now}}
		return old, nil
	}
	if err := f.run(r); err == nil {
		t.Fatal("expected conflict")
	}
	if len(f.publications) != 0 || len(f.rescheduled) != 1 || len(f.ackRequests) != 0 {
		t.Fatalf("publications=%v rescheduled=%v acks=%v", f.publications, f.rescheduled, f.ackRequests)
	}
}

func TestRepeatedDelayedHintsReadCurrentReopenedState(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "webhook"
	prior := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: 5, State: "open", GitHubUpdatedAt: f.now}}
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts {
		if len(f.publications) > 0 {
			p := f.publications[len(f.publications)-1][0]
			return store.GitHubPublicationFacts{Current: &p}
		}
		return store.GitHubPublicationFacts{Current: &prior}
	}
	remoteClient := f.remote()
	calls := 0
	remoteClient.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return observation(n, "open", f.now), nil
	}
	run := f.preparedRun(remoteClient)
	for _, id := range []string{"delayed-close", "duplicate-close"} {
		if err := run.hint(context.Background(), store.GitHubPendingPR{Number: 5, Generation: 7, RequestID: id}, "owner", "repo", nil); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 || len(f.publications) != 2 || len(f.ackRequests) != 2 {
		t.Fatalf("calls=%d publications=%v acks=%v", calls, f.publications, f.ackRequests)
	}
	for _, batch := range f.publications {
		if len(batch) != 1 || batch[0].State != "open" {
			t.Fatalf("stale hint reverted state: %+v", batch)
		}
	}
}

func TestSameSecondStaleSummaryUsesStableCurrentDetail(t *testing.T) {
	f := newPollFixture(t)
	f.facts = func(int64, *time.Time) store.GitHubPublicationFacts { return store.GitHubPublicationFacts{} }
	r := f.remote()
	calls := 0
	r.pull = func(_ context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		calls++
		return observation(n, "closed", f.now), nil
	}
	summary := remote.PullSummary{Number: 5, RepositoryID: 30, State: "open", UpdatedAt: f.now}
	o, err := f.preparedRun(r).checkedDetail(context.Background(), "owner", "repo", 5, []remote.PullSummary{summary})
	if err != nil || calls != 2 || o.State != "closed" {
		t.Fatalf("observation=%+v calls=%d err=%v", o, calls, err)
	}
}
