package webhook

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRetentionPayloadRechecksEligibility(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*store.WebhookDelivery)
		remove    bool
	}{
		{"expired", func(*store.WebhookDelivery) {}, true},
		{"exact deadline", func(d *store.WebhookDelivery) { d.PayloadExpiresAt = retentionTestNow }, true},
		{"before deadline", func(d *store.WebhookDelivery) { d.PayloadExpiresAt = retentionTestNow.Add(time.Nanosecond) }, false},
		{"already removed", func(d *store.WebhookDelivery) { d.PayloadRemovedAt = &retentionTestNow }, false},
		{"already closed", func(d *store.WebhookDelivery) { d.PurgingAt = &retentionTestNow }, false},
		{"live lease", func(d *store.WebhookDelivery) {
			d.State = "leased"
			at := retentionTestNow.Add(time.Minute)
			d.LeaseUntil = &at
		}, false},
		{"expired lease", func(d *store.WebhookDelivery) { d.State = "leased"; d.LeaseUntil = &retentionTestNow }, true},
		{"valid manual intent", func(d *store.WebhookDelivery) {
			d.State = "pending"
			d.Trigger = "manual"
			d.ExpiresAt = retentionTestNow.Add(time.Minute)
		}, false},
		{"expired pending intent", func(d *store.WebhookDelivery) { d.State = "pending"; d.ExpiresAt = retentionTestNow }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := retentionDeliveryFixture()
			tc.configure(&d)
			s := retentionCandidateScope(t, "payload", d)
			removed := 0
			s.payload = func(_ context.Context, id string, at time.Time) (int, error) {
				if id != d.ID || !at.Equal(retentionTestNow) {
					t.Errorf("payload arguments %s %v", id, at)
				}
				removed++
				return 1, nil
			}
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
				return retentionCallback(fn, s)
			}
			r := NewRetention(db)
			n, found, budget, err := r.step(t.Context(), 500)
			if err != nil || budget || found != tc.remove || n != removed || removed != map[bool]int{true: 1, false: 0}[tc.remove] {
				t.Fatalf("removed=%d n=%d found=%v budget=%v err=%v", removed, n, found, budget, err)
			}
		})
	}
}

func TestRetentionPayloadUsesTimeAfterCandidateLock(t *testing.T) {
	d := retentionDeliveryFixture()
	d.PayloadExpiresAt = retentionTestNow.Add(time.Second)
	s := retentionCandidateScope(t, "payload", d)
	times := 0
	s.now = func(context.Context) (time.Time, error) {
		times++
		return retentionTestNow.Add(time.Duration(times-1) * 2 * time.Second), nil
	}
	s.payload = func(_ context.Context, id string, at time.Time) (int, error) {
		if id != d.ID || !at.Equal(retentionTestNow.Add(2*time.Second)) {
			t.Fatalf("lock-after time %s %v", id, at)
		}
		return 1, nil
	}
	db := retentionEmptyStore(t)
	db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		return retentionCallback(f, s)
	}
	n, found, _, err := NewRetention(db).step(t.Context(), 500)
	if err != nil || n != 1 || !found || times != 2 {
		t.Fatalf("recheck n=%d found=%v times=%d err=%v", n, found, times, err)
	}
}

func TestRetentionCloseProtectsCurrentActivity(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*store.WebhookDelivery)
	}{
		{"future metadata", func(d *store.WebhookDelivery) { d.MetadataExpiresAt = retentionTestNow.Add(time.Second) }},
		{"closed", func(d *store.WebhookDelivery) { d.PurgingAt = &retentionTestNow }},
		{"lease", func(d *store.WebhookDelivery) {
			d.State = "leased"
			x := retentionTestNow.Add(time.Minute)
			d.LeaseUntil = &x
		}},
		{"pending", func(d *store.WebhookDelivery) { d.State = "pending"; d.ExpiresAt = retentionTestNow.Add(time.Minute) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := retentionDeliveryFixture()
			tc.configure(&d)
			s := retentionCandidateScope(t, "close", d)
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
				return retentionCallback(f, s)
			}
			n, found, more, err := NewRetention(db).step(t.Context(), 500)
			if err != nil || n != 0 || found || more {
				t.Fatalf("protected close %d %v %v %v", n, found, more, err)
			}
		})
	}
}

func TestRetentionCloseUsesLateActivityAndOriginalPolicy(t *testing.T) {
	for _, field := range []string{"finished", "late observed"} {
		t.Run(field, func(t *testing.T) {
			d := retentionDeliveryFixture()
			at := retentionTestNow.Add(-time.Hour)
			a := store.WebhookAttempt{}
			if field == "finished" {
				a.FinishedAt = &at
			} else {
				a.LateObservedAt = &at
			}
			s := retentionCandidateScope(t, "close", d)
			s.attempts = func(_ context.Context, id string) ([]store.WebhookAttempt, error) {
				if id != d.ID {
					t.Errorf("attempt delivery=%s", id)
				}
				return []store.WebhookAttempt{a}, nil
			}
			s.seconds = func(_ context.Context, v int64) (int, error) {
				if v != d.PolicyVersion {
					t.Errorf("policy=%d", v)
				}
				return 30 * 24 * 3600, nil
			}
			s.extend = func(_ context.Context, id string, last, expiry time.Time) (int, error) {
				if id != d.ID || !last.Equal(at) || !expiry.Equal(at.Add(30*24*time.Hour)) {
					t.Errorf("extension %s %v %v", id, last, expiry)
				}
				return 1, nil
			}
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
				return retentionCallback(f, s)
			}
			n, found, more, err := NewRetention(db).step(t.Context(), 500)
			if err != nil || n != 1 || !found || more {
				t.Fatalf("extension %d %v %v %v", n, found, more, err)
			}
			retentionAssertCallOrder(t, s.calls, "time", "candidate.purge", "candidate.close", "time", "attempts", "time", "policy", "extend")
		})
	}
}

func TestRetentionCloseValidatesAttemptBudgetAndCounts(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		count, budget, policy, rows int
		closed                      bool
		wantError                   bool
		wantMore                    bool
	}{
		{name: "empty", count: 0, budget: 1, policy: 30 * 24 * 3600, rows: 1},
		{name: "maximum", count: 13, budget: 14, policy: 30 * 24 * 3600, rows: 14},
		{name: "insufficient budget", count: 13, budget: 13, policy: 30 * 24 * 3600, rows: 0, wantMore: true},
		{name: "too many attempts", count: 14, budget: 500, policy: 30 * 24 * 3600, wantError: true},
		{name: "closed attempt", count: 1, budget: 500, policy: 30 * 24 * 3600, closed: true, wantError: true},
		{name: "missing policy", count: 0, budget: 500, policy: 0, wantError: true},
		{name: "negative policy", count: 0, budget: 500, policy: -1, wantError: true},
		{name: "wrong affected rows", count: 1, budget: 500, policy: 30 * 24 * 3600, rows: 1, wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := retentionDeliveryFixture()
			s := retentionCandidateScope(t, "close", d)
			attempts := make([]store.WebhookAttempt, tc.count)
			if tc.closed {
				attempts[0].RetentionClosedAt = &retentionTestNow
			}
			s.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return attempts, nil }
			s.seconds = func(context.Context, int64) (int, error) { return tc.policy, nil }
			closed := false
			s.close = func(_ context.Context, id string, now time.Time) (int, error) {
				closed = true
				if id != d.ID || !now.Equal(retentionTestNow) {
					t.Errorf("close arguments %s %v", id, now)
				}
				return tc.rows, nil
			}
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
				completion := store.Completion{Outcome: store.TransactionCommitted}
				if tc.wantError {
					completion.Outcome = store.TransactionNotCommitted
				}
				callback := f(s)
				retentionExpectCallback(t, callback, tc.wantError, nil)
				return completion, callback
			}
			n, found, more, err := NewRetention(db).step(t.Context(), tc.budget)
			if (err != nil) != tc.wantError || more != tc.wantMore {
				t.Fatalf("close n=%d found=%v more=%v err=%v", n, found, more, err)
			}
			if tc.wantMore && closed {
				t.Fatal("close exceeded shared row budget")
			}
			if !tc.wantError && !tc.wantMore && (n != tc.rows || !found || !closed) {
				t.Fatalf("missing committed close: %d %v %v", n, found, closed)
			}
		})
	}
}

func TestRetentionPurgeDeletesChildrenBeforeDelivery(t *testing.T) {
	for _, tc := range []struct {
		name               string
		children, delivery int
		wantError          bool
	}{
		{"children remain", 7, 0, false}, {"delete delivery", 0, 1, false}, {"undeletable children", 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := retentionDeliveryFixture()
			d.PurgingAt = &retentionTestNow
			s := retentionCandidateScope(t, "purge", d)
			s.children = func(_ context.Context, id string, budget int) (int, error) {
				if id != d.ID || budget != 11 {
					t.Errorf("purge arguments %s %d", id, budget)
				}
				return tc.children, nil
			}
			s.delivery = func(_ context.Context, id string) (int, error) {
				if id != d.ID {
					t.Errorf("delivery=%s", id)
				}
				return tc.delivery, nil
			}
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
				completion := store.Completion{Outcome: store.TransactionCommitted}
				if tc.wantError {
					completion.Outcome = store.TransactionNotCommitted
				}
				callback := f(s)
				retentionExpectCallback(t, callback, tc.wantError, nil)
				return completion, callback
			}
			n, found, _, err := NewRetention(db).step(t.Context(), 11)
			if (err != nil) != tc.wantError {
				t.Fatalf("purge n=%d found=%v err=%v", n, found, err)
			}
			want := []string{"time", "candidate.purge", "time", "children"}
			if tc.children == 0 {
				want = append(want, "delivery")
			}
			retentionAssertCallOrder(t, s.calls, want...)
			if !tc.wantError && (n != tc.children+tc.delivery || !found) {
				t.Fatalf("committed purge %d %v", n, found)
			}
		})
	}
}

func TestRetentionEventCleanupPhasesAndRotation(t *testing.T) {
	for _, phase := range []string{"orphan", "fact"} {
		t.Run(phase, func(t *testing.T) {
			s := retentionEmptyScope(t)
			if phase == "orphan" {
				s.orphan = func(context.Context) (string, int, error) { return "event", 2, nil }
			} else {
				s.fact = func(context.Context) (string, int, error) { return "event", 3, nil }
			}
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
				return retentionCallback(f, s)
			}
			r := NewRetention(db)
			n, found, _, err := r.step(t.Context(), 500)
			if err != nil || !found || n < 2 {
				t.Fatalf("event cleanup %d %v %v", n, found, err)
			}
			want := 4
			if phase == "fact" {
				want = 0
			}
			if r.historyPhase != want {
				t.Fatalf("phase rotation %d want%d", r.historyPhase, want)
			}
			e := <-r.Events()
			if e.Phase != phase || e.EventID != "event" || e.ConfirmedRows != n {
				t.Fatalf("event=%+v", e)
			}
		})
	}
}

func TestRetentionStepPropagatesEveryDAOFailure(t *testing.T) {
	failure := errors.New("retention DAO failure")
	for _, phase := range []string{"first clock", "candidate", "second clock", "children", "delivery", "payload", "attempts", "third clock", "policy", "extend", "close", "orphan", "fact"} {
		t.Run(phase, func(t *testing.T) {
			d := retentionDeliveryFixture()
			kind := "close"
			switch phase {
			case "children", "delivery":
				kind = "purge"
			case "payload":
				kind = "payload"
			case "orphan", "fact", "candidate", "first clock":
				kind = ""
			}
			s := retentionCandidateScope(t, kind, d)
			s.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, nil }
			s.seconds = func(context.Context, int64) (int, error) { return 30 * 24 * 3600, nil }
			switch phase {
			case "first clock":
				s.now = func(context.Context) (time.Time, error) { return time.Time{}, failure }
			case "candidate":
				s.candidate = func(context.Context, string, time.Time) (store.WebhookDelivery, bool, error) {
					return store.WebhookDelivery{}, false, failure
				}
			case "second clock", "third clock":
				calls := 0
				at := 2
				if phase == "third clock" {
					at = 3
				}
				s.now = func(context.Context) (time.Time, error) {
					calls++
					if calls == at {
						return time.Time{}, failure
					}
					return retentionTestNow, nil
				}
			case "children":
				s.children = func(context.Context, string, int) (int, error) { return 0, failure }
			case "delivery":
				s.children = func(context.Context, string, int) (int, error) { return 0, nil }
				s.delivery = func(context.Context, string) (int, error) { return 0, failure }
			case "payload":
				s.payload = func(context.Context, string, time.Time) (int, error) { return 0, failure }
			case "attempts":
				s.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) { return nil, failure }
			case "policy":
				s.seconds = func(context.Context, int64) (int, error) { return 0, failure }
			case "extend":
				s.attempts = func(context.Context, string) ([]store.WebhookAttempt, error) {
					x := retentionTestNow
					return []store.WebhookAttempt{{FinishedAt: &x}}, nil
				}
				s.extend = func(context.Context, string, time.Time, time.Time) (int, error) { return 0, failure }
			case "close":
				s.close = func(context.Context, string, time.Time) (int, error) { return 0, failure }
			case "orphan":
				s.orphan = func(context.Context) (string, int, error) { return "", 0, failure }
			case "fact":
				s.fact = func(context.Context) (string, int, error) { return "", 0, failure }
			}
			db := retentionEmptyStore(t)
			db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
				callback := f(s)
				retentionExpectCallback(t, callback, true, failure)
				return store.Completion{Outcome: store.TransactionNotCommitted}, failure
			}
			n, found, more, err := NewRetention(db).step(t.Context(), 500)
			if !errors.Is(err, failure) || n != 0 || found || more {
				t.Fatalf("lost DAO error n=%d found=%v more=%v err=%v", n, found, more, err)
			}
		})
	}
}

func TestRetentionUncommittedChangesNeverCountAsConfirmed(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown} {
		for _, withError := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s error=%t", outcome, withError), func(t *testing.T) {
				d := retentionDeliveryFixture()
				s := retentionCandidateScope(t, "payload", d)
				s.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
				failure := errors.New("private transaction cause")
				db := retentionEmptyStore(t)
				db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
					if err := f(s); err != nil {
						t.Fatal(err)
					}
					var err error
					if withError {
						err = failure
					}
					return store.Completion{Outcome: outcome}, err
				}
				r := NewRetention(db)
				n, found, more, err := r.step(t.Context(), 500)
				if err == nil || n != 0 || found || more {
					t.Fatalf("unconfirmed rows %d %v %v %v", n, found, more, err)
				}
				if withError && !errors.Is(err, failure) {
					t.Fatal("lost transaction cause")
				}
				if (outcome == store.TransactionUnknown) != (r.pending != nil) {
					t.Fatalf("pending=%v", r.pending)
				}
				if r.pending != nil && (r.pending.kind != "delivery" || r.pending.id != d.ID) {
					t.Fatalf("pending identity=%+v", r.pending)
				}
				if event := <-r.Events(); event.ConfirmedRows != 0 || strings.Contains(event.ErrorCode, "private") {
					t.Fatalf("unsafe event %+v", event)
				}
			})
		}
	}
}
