package github

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

// A transaction-local wrapper records publication and acknowledgement ordering.
// Its queue models due work; rescheduled entries are no longer due in this run.
type pollHintsHarness struct {
	f            *pollFixture
	queue        []store.GitHubPendingPR
	events       []string
	pendingCount int
	pendingError error
	loseLease    bool
	unknownAck   bool
	acked        bool
	rows         map[int64]githubpr.PullRequest
	cursors      []int64
}

type pollHintsDAO struct {
	store.GitHubWorkDAO
	h         *pollHintsHarness
	published int64
}

func (h *pollHintsHarness) install() {
	write := h.f.db.write
	h.f.db.write = func(ctx context.Context, id string, work func(store.GitHubWorkDAO) error) (store.Completion, error) {
		h.acked = false
		result, err := write(ctx, id, func(source store.GitHubWorkDAO) error {
			return work(&pollHintsDAO{GitHubWorkDAO: source, h: h})
		})
		if h.unknownAck && h.acked && err == nil {
			return store.Completion{Outcome: store.TransactionUnknown}, errors.New("ack commit response lost")
		}
		return result, err
	}
}

func (d *pollHintsDAO) Pending(_ context.Context, lease store.GitHubLease, _ time.Time, limit int) ([]store.GitHubPendingPR, bool, error) {
	h := d.h
	if lease != h.f.lease || limit != 1 {
		h.f.t.Fatalf("pending lease=%+v limit=%d", lease, limit)
	}
	h.pendingCount++
	h.events = append(h.events, "pending")
	if h.pendingCount > 1 && h.pendingError != nil {
		return nil, false, h.pendingError
	}
	if h.pendingCount > 1 && h.loseLease {
		return nil, false, nil
	}
	if len(h.queue) == 0 {
		return nil, true, nil
	}
	return h.queue[:1], true, nil
}

func (d *pollHintsDAO) Publish(ctx context.Context, lease store.GitHubLease, items []githubpr.PullRequest) (bool, error) {
	ok, err := d.GitHubWorkDAO.Publish(ctx, lease, items)
	if ok && err == nil {
		d.published = items[0].Number
		for _, item := range items {
			if d.h.rows != nil {
				if previous, exists := d.h.rows[item.Number]; exists && item.SeenPollID == nil {
					item.SeenPollID = previous.SeenPollID
				}
				d.h.rows[item.Number] = item
			}
		}
		d.h.events = append(d.h.events, fmt.Sprintf("publish:%d", items[0].Number))
	}
	return ok, err
}

func (d *pollHintsDAO) UnseenActive(ctx context.Context, lease store.GitHubLease, pollID string, after int64, limit int) ([]int64, bool, error) {
	if d.h.rows == nil {
		return d.GitHubWorkDAO.UnseenActive(ctx, lease, pollID, after, limit)
	}
	if lease != d.h.f.lease || pollID != lease.Token || limit != 100 {
		d.h.f.t.Fatalf("unseen lease=%+v poll=%q limit=%d", lease, pollID, limit)
	}
	d.h.cursors = append(d.h.cursors, after)
	var numbers []int64
	for n, row := range d.h.rows {
		if n > after && row.State == "open" && (row.SeenPollID == nil || *row.SeenPollID != pollID) {
			numbers = append(numbers, n)
		}
	}
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	if len(numbers) > limit {
		numbers = numbers[:limit]
	}
	return numbers, true, nil
}

func (d *pollHintsDAO) AckPending(_ context.Context, lease store.GitHubLease, number int64, request string) (bool, error) {
	h := d.h
	if lease != h.f.lease || d.published != number || len(h.queue) == 0 || h.queue[0].Number != number || h.queue[0].RequestID != request {
		h.f.t.Fatalf("ack not paired with publication and original request: number=%d request=%q published=%d queue=%+v", number, request, d.published, h.queue)
	}
	h.events = append(h.events, "ack:"+request)
	h.queue = h.queue[1:]
	h.acked = true
	return true, nil
}

func (d *pollHintsDAO) HasPending(_ context.Context, lease store.GitHubLease) (bool, bool, error) {
	if lease != d.h.f.lease || !d.h.acked {
		d.h.f.t.Fatal("HasPending before matching ack")
	}
	return len(d.h.queue) > 0, true, nil
}

func (d *pollHintsDAO) ReschedulePending(_ context.Context, lease store.GitHubLease, number int64, request string, next time.Time) (bool, error) {
	h := d.h
	if lease != h.f.lease || len(h.queue) == 0 || h.queue[0].Number != number || h.queue[0].RequestID != request || next.Before(h.f.now.Add(30*time.Second)) {
		h.f.t.Fatalf("invalid reschedule: %d %q %v", number, request, next)
	}
	h.events = append(h.events, "reschedule:"+request)
	h.queue = h.queue[1:]
	return true, nil
}

func (d *pollHintsDAO) SaveRuntime(ctx context.Context, lease store.GitHubLease, w store.GitHubRuntimeWrite) (bool, error) {
	if w.LastFullSuccessAt != nil {
		d.h.events = append(d.h.events, "full-success")
	}
	return d.GitHubWorkDAO.SaveRuntime(ctx, lease, w)
}

func hintFor(number int64, id string) store.GitHubPendingPR {
	return store.GitHubPendingPR{Number: number, Generation: 7, RequestID: id, DeliveryID: "delivery-" + id}
}

func (h *pollHintsHarness) remote() executorRemote {
	r := h.f.remote()
	r.list = func(ctx context.Context, _ int64, _, _ string, visit func([]githubpr.Observation) error) error {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return err
		}
		return visit([]githubpr.Observation{observation(1, "open", h.f.now)})
	}
	r.pull = func(ctx context.Context, _ int64, _, _ string, n int64) (githubpr.Observation, error) {
		h.events = append(h.events, fmt.Sprintf("fetch:%d", n))
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.Observation{}, err
		}
		return observation(n, "open", h.f.now), nil
	}
	return r
}

func TestPollInterleavesOneHintAfterEachPublication(t *testing.T) {
	f := newPollFixture(t)
	f.unseen = []int64{91, 92, 93}
	h := &pollHintsHarness{f: f, queue: []store.GitHubPendingPR{hintFor(5, "page")}}
	h.install()
	r := h.remote()
	pull := r.pull
	r.pull = func(ctx context.Context, i int64, owner, name string, n int64) (githubpr.Observation, error) {
		if n == 91 {
			// These arrive after the open-page opportunity and during the first detail read.
			h.queue = append(h.queue, hintFor(6, "first"), hintFor(7, "second"), hintFor(8, "third"), hintFor(9, "remaining"))
		}
		return pull(ctx, i, owner, name, n)
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	want := []string{"publish:1", "pending", "fetch:5", "publish:5", "ack:page", "fetch:91", "publish:91", "pending", "fetch:6", "publish:6", "ack:first", "fetch:92", "publish:92", "pending", "fetch:7", "publish:7", "ack:second", "fetch:93", "publish:93", "pending", "fetch:8", "publish:8", "ack:third", "full-success"}
	if !reflect.DeepEqual(h.events, want) {
		t.Fatalf("events = %v; want %v", h.events, want)
	}
	if len(h.queue) != 1 || h.queue[0].RequestID != "remaining" {
		t.Fatalf("remaining due work: %+v", h.queue)
	}
	last := f.runtimes[len(f.runtimes)-1]
	if last.LastFullSuccessAt == nil || !last.LastFullSuccessAt.Equal(f.now) || !last.ReleaseClaim {
		t.Fatalf("poll completion: %+v", last)
	}
}

func TestPollContinuesAfterHintIsRescheduled(t *testing.T) {
	f := newPollFixture(t)
	f.unseen = []int64{91, 92}
	h := &pollHintsHarness{f: f}
	h.install()
	r := h.remote()
	pull := r.pull
	r.pull = func(ctx context.Context, i int64, owner, name string, n int64) (githubpr.Observation, error) {
		if n == 91 {
			h.queue = append(h.queue, hintFor(4, "failed"), hintFor(5, "next"))
		}
		if n == 4 {
			h.events = append(h.events, "fetch:4")
			return githubpr.Observation{}, errors.New("temporary failure")
		}
		return pull(ctx, i, owner, name, n)
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	want := []string{"publish:1", "pending", "fetch:91", "publish:91", "pending", "fetch:4", "reschedule:failed", "fetch:92", "publish:92", "pending", "fetch:5", "publish:5", "ack:next", "full-success"}
	if !reflect.DeepEqual(h.events, want) {
		t.Fatalf("events = %v; want %v", h.events, want)
	}
}

func TestPollHintFailuresStopBeforeNextDetail(t *testing.T) {
	for _, tc := range []struct {
		name         string
		cause        error
		pendingError error
		loseLease    bool
		unknownAck   bool
		rateLimit    bool
	}{
		{name: "rate-limit", cause: &remote.Error{Code: "rate_limited", Status: 429, RetryAt: time.Date(2026, 1, 1, 0, 4, 0, 0, time.UTC)}, rateLimit: true},
		{name: "cancel", cause: context.Canceled},
		{name: "pending-transaction", pendingError: errors.New("pending failed")},
		{name: "lease-lost", loseLease: true},
		{name: "unknown-ack-commit", unknownAck: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPollFixture(t)
			f.unseen = []int64{91, 92}
			h := &pollHintsHarness{f: f, pendingError: tc.pendingError, loseLease: tc.loseLease, unknownAck: tc.unknownAck}
			h.install()
			r := h.remote()
			pull := r.pull
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r.pull = func(ctx context.Context, i int64, owner, name string, n int64) (githubpr.Observation, error) {
				if n == 91 {
					h.queue = append(h.queue, hintFor(5, "during-detail"))
				}
				if n == 5 && tc.cause != nil {
					h.events = append(h.events, "fetch:5")
					if err := remote.CheckpointRequest(ctx); err != nil {
						return githubpr.Observation{}, err
					}
					if errors.Is(tc.cause, context.Canceled) {
						cancel()
						return githubpr.Observation{}, ctx.Err()
					}
					return githubpr.Observation{}, tc.cause
				}
				return pull(ctx, i, owner, name, n)
			}
			err := f.preparedRun(r).execute(ctx)
			if err == nil {
				t.Fatal("expected incomplete poll")
			}
			if tc.cause != nil && !errors.Is(err, tc.cause) || tc.pendingError != nil && (!errors.Is(err, tc.pendingError) || !errors.Is(err, errTransaction)) || tc.loseLease && !errors.Is(err, errLease) || tc.unknownAck && !errors.Is(err, errUnknown) {
				t.Fatalf("unexpected error: %v", err)
			}
			for _, event := range h.events {
				if event == "fetch:92" || event == "full-success" {
					t.Fatalf("continued after failure: %v", h.events)
				}
			}
			if len(f.publications) < 2 || f.publications[1][0].Number != 91 {
				t.Fatalf("previous detail was not published: %+v", f.publications)
			}
			if tc.rateLimit {
				last := f.runtimes[len(f.runtimes)-1]
				if last.PollErrorCode == nil || *last.PollErrorCode != "github_rate_limited" || last.NextPollAt == nil || !last.NextPollAt.Equal(f.now.Add(4*time.Minute)) || last.NotBefore == nil || !last.ReleaseClaim {
					t.Fatalf("rate-limit result: %+v", last)
				}
			}
		})
	}
}

// An in-poll hint must not create another unseen active row in a later batch.
func TestPollHintDoesNotExtendDynamicAbsenceTraversal(t *testing.T) {
	f := newPollFixture(t)
	h := &pollHintsHarness{f: f, rows: make(map[int64]githubpr.PullRequest)}
	for n := int64(101); n <= 201; n++ {
		h.rows[n] = githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: n, State: "open"}}
	}
	h.install()
	r := h.remote()
	pull := r.pull
	r.pull = func(ctx context.Context, i int64, owner, name string, n int64) (githubpr.Observation, error) {
		if n == 101 {
			h.queue = append(h.queue, hintFor(1000, "new-open"))
		}
		return pull(ctx, i, owner, name, n)
	}
	if err := f.run(r); err != nil {
		t.Fatal(err)
	}
	row := h.rows[1000]
	if row.SeenPollID == nil || *row.SeenPollID != f.lease.Token {
		t.Fatalf("hint publication missing poll token: %+v", row)
	}
	if !reflect.DeepEqual(h.cursors, []int64{0, 200, 201}) {
		t.Fatalf("unexpected absence batches: %v", h.cursors)
	}
	var hintReads int
	for _, event := range h.events {
		if event == "fetch:1000" {
			hintReads++
		}
	}
	if hintReads != 1 || h.events[len(h.events)-1] != "full-success" || len(h.queue) != 0 {
		t.Fatalf("hint reads=%d events=%v remaining=%v", hintReads, h.events, h.queue)
	}
}
