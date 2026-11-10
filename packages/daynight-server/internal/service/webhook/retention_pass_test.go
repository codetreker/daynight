package webhook

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type retentionConfigScopeMock struct {
	t      *testing.T
	lock   func(context.Context, store.WebhookConfigGCCandidate) (store.WebhookConfigGCFacts, error)
	remove func(context.Context, store.WebhookConfigGCCandidate) (bool, error)
}

func (m retentionConfigScopeMock) LockConfigCandidate(c context.Context, a store.WebhookConfigGCCandidate) (store.WebhookConfigGCFacts, error) {
	return retentionRequire(m.t, "LockConfigCandidate", m.lock, m.lock != nil)(c, a)
}
func (m retentionConfigScopeMock) DeleteConfigCandidate(c context.Context, a store.WebhookConfigGCCandidate) (bool, error) {
	return retentionRequire(m.t, "DeleteConfigCandidate", m.remove, m.remove != nil)(c, a)
}

type retentionReceiptScopeMock struct {
	t      *testing.T
	expiry func(context.Context, store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error)
	remove func(context.Context, store.WebhookReceiptIdentity) (bool, error)
}

func (m retentionReceiptScopeMock) ReceiptExpiry(c context.Context, a store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
	return retentionRequire(m.t, "ReceiptExpiry", m.expiry, m.expiry != nil)(c, a)
}
func (m retentionReceiptScopeMock) DeleteReceipt(c context.Context, a store.WebhookReceiptIdentity) (bool, error) {
	return retentionRequire(m.t, "DeleteReceipt", m.remove, m.remove != nil)(c, a)
}

func TestRetentionPassPropagatesConfigurationResults(t *testing.T) {
	for _, result := range []int{0, 1} {
		t.Run(fmt.Sprint(result), func(t *testing.T) {
			db := retentionEmptyStore(t)
			r := retentionWithConfigCollector(t, db, []string{"reconcile", "pass"}, func(context.Context, store.WebhookConfigGC, int) (int, error) {
				return result, nil
			})
			n, more, err := r.Pass(t.Context())
			obs := r.Observation()
			if err != nil || n != result || more || obs.ConfigRows != result || obs.ConfirmedRows != result || obs.ContinueSoon || obs.Failed {
				t.Fatalf("configuration n=%d more=%v obs=%+v err=%v", n, more, obs, err)
			}
		})
	}
}

func TestRetentionPassOnlyDeletesExpiredReceipt(t *testing.T) {
	for _, kind := range []string{"expired", "exact expiry", "future", "absent", "fence busy"} {
		t.Run(kind, func(t *testing.T) {
			db := retentionEmptyStore(t)
			id := store.WebhookReceiptIdentity{OperationID: "operation", Owner: Owner{Kind: "personal", ID: "owner"}}
			db.expiredReceipts = func(context.Context, *store.WebhookReceiptIdentity, int) ([]store.WebhookReceiptIdentity, error) {
				return []store.WebhookReceiptIdentity{id}, nil
			}
			deleted := false
			sc := retentionReceiptScopeMock{t: t, expiry: func(_ context.Context, a store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
				if a != id {
					t.Fatal("receipt namespace changed")
				}
				at := retentionTestNow.Add(-time.Second)
				if kind == "future" {
					at = retentionTestNow.Add(time.Second)
				} else if kind == "exact expiry" {
					at = retentionTestNow
				}
				return at, retentionTestNow, kind != "absent", nil
			}, remove: func(_ context.Context, a store.WebhookReceiptIdentity) (bool, error) {
				if a != id {
					t.Fatal("wrong receipt removed")
				}
				deleted = true
				return true, nil
			}}
			db.writeReceipt = func(_ context.Context, a store.WebhookReceiptIdentity, f func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
				if a != id {
					t.Fatal("receipt transaction namespace changed")
				}
				if kind == "fence busy" {
					return store.Completion{Outcome: store.TransactionNotCommitted}, store.ErrWebhookReceiptFenceBusy
				}
				if err := f(sc); err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}
			r := NewRetention(db)
			n, _, err := r.Pass(t.Context())
			want := kind == "expired" || kind == "exact expiry"
			if err != nil || deleted != want || n != map[bool]int{true: 1, false: 0}[want] || r.Observation().ReceiptRows != n {
				t.Fatalf("receipt %d deleted=%v err=%v", n, deleted, err)
			}
		})
	}
}

func retentionUnknownScenario(t *testing.T, mode string) (*Retention, *retentionStoreMock, *atomic.Bool, *atomic.Int64) {
	db := retentionEmptyStore(t)
	writes := &atomic.Int64{}
	observed := &atomic.Bool{}
	failure := errors.New("private reply lost")
	scan := &atomic.Int64{}
	switch mode {
	case "config":
		id := store.WebhookConfigGCCandidate{ID: "original", Kind: "binding"}
		db.scanConfig = func(context.Context, *store.WebhookConfigGCCandidate, int) (store.WebhookConfigGCScan, error) {
			if scan.Add(1) == 1 {
				return store.WebhookConfigGCScan{Barrier: "1", Candidates: []store.WebhookConfigGCCandidate{id}}, nil
			}
			return store.WebhookConfigGCScan{}, nil
		}
		db.configBarrier = func(context.Context, string) (bool, error) { return true, nil }
		db.writeConfig = func(_ context.Context, a store.WebhookConfigGCCandidate, f func(store.WebhookConfigGCScope) error) (store.Completion, error) {
			writes.Add(1)
			sc := retentionConfigScopeMock{t: t, lock: func(context.Context, store.WebhookConfigGCCandidate) (store.WebhookConfigGCFacts, error) {
				return store.WebhookConfigGCFacts{Present: true, Retired: true}, nil
			}, remove: func(context.Context, store.WebhookConfigGCCandidate) (bool, error) { return true, nil }}
			if err := f(sc); err != nil {
				t.Error(err)
			}
			return store.Completion{Outcome: store.TransactionUnknown}, failure
		}
		db.observeConfig = func(_ context.Context, a store.WebhookConfigGCCandidate) (bool, error) {
			if a != id {
				t.Error("uncertain configuration identity changed")
			}
			observed.Store(true)
			return false, nil
		}
	case "receipt":
		id := store.WebhookReceiptIdentity{OperationID: "original"}
		db.expiredReceipts = func(context.Context, *store.WebhookReceiptIdentity, int) ([]store.WebhookReceiptIdentity, error) {
			if scan.Add(1) == 1 {
				return []store.WebhookReceiptIdentity{id}, nil
			}
			return nil, nil
		}
		db.writeReceipt = func(_ context.Context, a store.WebhookReceiptIdentity, f func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
			writes.Add(1)
			sc := retentionReceiptScopeMock{t: t, expiry: func(context.Context, store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
				return retentionTestNow.Add(-time.Second), retentionTestNow, true, nil
			}, remove: func(context.Context, store.WebhookReceiptIdentity) (bool, error) { return true, nil }}
			if err := f(sc); err != nil {
				t.Error(err)
			}
			return store.Completion{Outcome: store.TransactionUnknown}, failure
		}
		db.observeReceipt = func(_ context.Context, a store.WebhookReceiptIdentity) (time.Time, bool, error) {
			if a != id {
				t.Error("uncertain receipt identity changed")
			}
			observed.Store(true)
			return time.Time{}, false, nil
		}
	case "history":
		d := retentionDeliveryFixture()
		db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
			if scan.Add(1) == 1 {
				writes.Add(1)
				s := retentionCandidateScope(t, "payload", d)
				s.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
				if err := f(s); err != nil {
					t.Error(err)
				}
				return store.Completion{Outcome: store.TransactionUnknown}, failure
			}
			if !observed.Load() {
				t.Error("history transaction before unknown readback")
			}
			return retentionCallback(f, retentionEmptyScope(t))
		}
		db.observeHistory = func(_ context.Context, k, id string) error {
			if k != "delivery" || id != d.ID {
				t.Error("uncertain history identity changed")
			}
			observed.Store(true)
			return nil
		}
	default:
		t.Fatalf("invalid test mode %s", mode)
	}
	return NewRetention(db), db, observed, writes
}

func TestRetentionReconcilesEveryUnknownBeforeMoreWrites(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			r, db, observed, writes := retentionUnknownScenario(t, mode)
			n, _, err := r.Pass(t.Context())
			if err == nil || n != 0 || !r.Observation().Unknown || !r.Observation().Failed || writes.Load() != 1 {
				t.Fatalf("unknown pass %d %+v writes%d err%v", n, r.Observation(), writes.Load(), err)
			}
			before := len(db.recorded())
			n, _, err = r.Pass(t.Context())
			if err != nil || n != 0 || !observed.Load() || r.Observation().Unknown || writes.Load() != 1 {
				t.Fatalf("reconcile %d %+v writes%d err%v", n, r.Observation(), writes.Load(), err)
			}
			calls := db.recorded()[before:]
			want := mode + ".observe"
			if len(calls) == 0 || calls[0] != want {
				t.Fatalf("readback must precede all fresh work: %v", calls)
			}
		})
	}
}

func TestRetentionKeepsUnreadableUnknownWithoutRepeatingWrite(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			r, db, observed, writes := retentionUnknownScenario(t, mode)
			failure := errors.New("readback unavailable")
			fail := true
			config, receipt, history := db.observeConfig, db.observeReceipt, db.observeHistory
			switch mode {
			case "config":
				db.observeConfig = func(c context.Context, a store.WebhookConfigGCCandidate) (bool, error) {
					if fail {
						return false, failure
					}
					return config(c, a)
				}
			case "receipt":
				db.observeReceipt = func(c context.Context, a store.WebhookReceiptIdentity) (time.Time, bool, error) {
					if fail {
						return time.Time{}, false, failure
					}
					return receipt(c, a)
				}
			case "history":
				db.observeHistory = func(c context.Context, k, id string) error {
					if fail {
						return failure
					}
					return history(c, k, id)
				}
			}
			_, _, err := r.Pass(t.Context())
			if err == nil {
				t.Fatal("unknown disappeared")
			}
			_, _, err = r.Pass(t.Context())
			if !errors.Is(err, failure) || !r.Observation().Unknown || writes.Load() != 1 || observed.Load() {
				t.Fatalf("unreadable unknown %+v writes%d err%v", r.Observation(), writes.Load(), err)
			}
			fail = false
			_, _, err = r.Pass(t.Context())
			if err != nil || r.Observation().Unknown || writes.Load() != 1 || !observed.Load() {
				t.Fatalf("resolved unknown %+v err%v", r.Observation(), err)
			}
		})
	}
}

func TestRetentionPassInternalBudgetDoesNotCancelItsParent(t *testing.T) {
	db := retentionEmptyStore(t)
	r := retentionWithConfigCollector(t, db, []string{"reconcile", "pass", "reconcile", "pass"}, func(c context.Context, _ store.WebhookConfigGC, _ int) (int, error) {
		<-c.Done()
		return 0, c.Err()
	})
	parent := context.Background()
	n, more, err := r.pass(parent, 20*time.Millisecond)
	if err != nil || n != 0 || !more || parent.Err() != nil || r.Observation().Failed {
		t.Fatalf("internal budget n%d more%v parent%v obs%+v err%v", n, more, parent.Err(), r.Observation(), err)
	}
	c, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err = r.Pass(c)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("parent cancellation lost: %v", err)
	}
}

func TestRetentionContinuesOtherClassesAfterConfigTimeout(t *testing.T) {
	db := retentionEmptyStore(t)
	passes := 0
	r := retentionWithConfigCollector(t, db, []string{"reconcile", "pass", "reconcile", "pass"}, func(c context.Context, _ store.WebhookConfigGC, _ int) (int, error) {
		passes++
		if passes == 1 {
			<-c.Done()
			return 0, c.Err()
		}
		return 0, nil
	})
	_, more, err := r.pass(context.Background(), 20*time.Millisecond)
	if err != nil || !more {
		t.Fatalf("config budget %v %v", more, err)
	}
	d := retentionDeliveryFixture()
	writes := 0
	db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		writes++
		if writes == 1 {
			s := retentionCandidateScope(t, "payload", d)
			s.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
			return retentionCallback(f, s)
		}
		return retentionCallback(f, retentionEmptyScope(t))
	}
	n, _, err := r.Pass(t.Context())
	if err != nil || n != 1 || r.Observation().HistoryRows != 1 {
		t.Fatalf("other classes did not progress %d %+v %v", n, r.Observation(), err)
	}
}

func TestRetentionPassIsSingleFlightAndUsesProductionBudget(t *testing.T) {
	if _, _, err := NewRetention(nil).Pass(t.Context()); err == nil {
		t.Fatal("missing store accepted")
	}
	db := retentionEmptyStore(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	r := retentionWithConfigCollector(t, db, []string{"reconcile", "pass"}, func(c context.Context, _ store.WebhookConfigGC, _ int) (int, error) {
		close(entered)
		select {
		case <-release:
			return 0, nil
		case <-c.Done():
			return 0, c.Err()
		}
	})
	parent, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	drained := false
	t.Cleanup(func() {
		cancel()
		once.Do(func() { close(release) })
		if !drained {
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Error("retention pass did not drain")
			}
		}
	})
	go func() { _, _, err := r.Pass(parent); done <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("pass did not enter")
	}
	n, more, err := r.Pass(t.Context())
	if err != nil || n != 0 || !more {
		t.Fatalf("concurrent pass %d %v %v", n, more, err)
	}
	once.Do(func() { close(release) })
	select {
	case err := <-done:
		drained = true
		retentionFail(t, err)
	case <-time.After(time.Second):
		t.Fatal("retention pass did not drain")
	}
	db = retentionEmptyStore(t)
	started := time.Now()
	r = retentionWithConfigCollector(t, db, []string{"reconcile", "pass"}, func(c context.Context, _ store.WebhookConfigGC, _ int) (int, error) {
		deadline, ok := c.Deadline()
		if !ok || deadline.Sub(started) < 1900*time.Millisecond || deadline.Sub(started) > 2100*time.Millisecond {
			t.Errorf("production budget=%v present=%v", deadline.Sub(started), ok)
		}
		return 0, nil
	})
	_, _, err = r.Pass(t.Context())
	retentionFail(t, err)
}

func TestRetentionSharedAffectedRowBudgetCountsEachClass(t *testing.T) {
	db := retentionEmptyStore(t)
	receipts := make([]store.WebhookReceiptIdentity, 125)
	for i := range receipts {
		receipts[i] = store.WebhookReceiptIdentity{OperationID: fmt.Sprint(i)}
	}
	db.expiredReceipts = func(_ context.Context, _ *store.WebhookReceiptIdentity, n int) ([]store.WebhookReceiptIdentity, error) {
		if n != 125 {
			t.Fatalf("receipt budget%d", n)
		}
		return receipts, nil
	}
	db.writeReceipt = func(_ context.Context, _ store.WebhookReceiptIdentity, f func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
		s := retentionReceiptScopeMock{t: t, expiry: func(context.Context, store.WebhookReceiptIdentity) (time.Time, time.Time, bool, error) {
			return retentionTestNow, retentionTestNow, true, nil
		}, remove: func(context.Context, store.WebhookReceiptIdentity) (bool, error) { return true, nil }}
		if err := f(s); err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	history := 0
	db.writeHistory = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		history++
		if history > 250 {
			t.Fatal("history exceeded shared budget")
		}
		d := retentionDeliveryFixture()
		d.ID = fmt.Sprintf("%08x-1111-4111-8111-111111111111", history)
		s := retentionCandidateScope(t, "payload", d)
		s.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
		return retentionCallback(f, s)
	}
	r := retentionWithConfigCollector(t, db, []string{"reconcile", "pass"}, func(context.Context, store.WebhookConfigGC, int) (int, error) { return 125, nil })
	n, more, err := r.Pass(t.Context())
	obs := r.Observation()
	if err != nil || n != 500 || !more || history != 250 || obs.ConfigRows != 125 || obs.ReceiptRows != 125 || obs.HistoryRows != 250 || obs.ConfirmedRows != 500 {
		t.Fatalf("shared budget n%d more%v history%d obs%+v err%v", n, more, history, obs, err)
	}
}
