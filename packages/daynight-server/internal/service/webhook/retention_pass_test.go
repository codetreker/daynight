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
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

func TestRetentionConstructorBindsDistinctCollectorInstances(t *testing.T) {
	db := retentionEmptyStore(t)
	first, second := NewRetention(db), NewRetention(db)
	config, ok := first.config.(*core.ConfigCollector)
	if !ok || config == nil {
		t.Fatal("missing default config collector")
	}
	receipt, ok := first.receipts.(*core.ReceiptCollector)
	if !ok || receipt == nil {
		t.Fatal("missing default receipt collector")
	}
	if first.config != config || first.receipts != receipt || first.config == second.config || first.receipts == second.receipts {
		t.Fatal("retention collector identity is not per instance")
	}
	if other, ok := second.config.(*core.ConfigCollector); !ok || other == nil {
		t.Fatal("second config binding is missing")
	}
	if other, ok := second.receipts.(*core.ReceiptCollector); !ok || other == nil {
		t.Fatal("second receipt binding is missing")
	}
}

func TestRetentionPassPropagatesConfigurationResults(t *testing.T) {
	for _, result := range []int{0, 1} {
		t.Run(fmt.Sprint(result), func(t *testing.T) {
			db := retentionEmptyStore(t)
			r, p := retentionWithCollectors(t, db)
			p.queue(retentionPassCalls(result, 0, "config", "receipt", "history")...)
			n, more, err := r.Pass(t.Context())
			obs := r.Observation()
			if err != nil || n != result || more || obs.ConfigRows != result || obs.ConfirmedRows != result || obs.ContinueSoon || obs.Failed {
				t.Fatalf("configuration n=%d more=%v obs=%+v err=%v", n, more, obs, err)
			}
		})
	}
}

func TestRetentionPassPropagatesReceiptResults(t *testing.T) {
	for _, result := range []int{0, 1} {
		t.Run(fmt.Sprint(result), func(t *testing.T) {
			db := retentionEmptyStore(t)
			r, p := retentionWithCollectors(t, db)
			p.queue(retentionPassCalls(0, result, "config", "receipt", "history")...)
			n, more, err := r.Pass(t.Context())
			obs := r.Observation()
			if err != nil || n != result || more || obs.ReceiptRows != result || obs.ConfirmedRows != result || obs.ContinueSoon || obs.Failed {
				t.Fatalf("receipt n=%d more=%v obs=%+v err=%v", n, more, obs, err)
			}
		})
	}
}

type retentionUnknownFixture struct {
	r            *Retention
	plan         *retentionCollectorPlan
	observed     atomic.Bool
	unknownCalls atomic.Int64
	mode         string
	failure      error
}

func retentionUnknownScenario(t *testing.T, mode string) *retentionUnknownFixture {
	db := retentionEmptyStore(t)
	scenario := &retentionUnknownFixture{mode: mode, failure: errors.New("private reply lost")}
	d := retentionDeliveryFixture()
	if mode == "history" {
		first := true
		db.writeHistory = func(_ context.Context, fn func(store.WebhookRetentionScope) error) (store.Completion, error) {
			if first {
				first = false
				scenario.unknownCalls.Add(1)
				scope := retentionCandidateScope(t, "payload", d)
				scope.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
				retentionExpectCallback(t, fn(scope), false, nil)
				return store.Completion{Outcome: store.TransactionUnknown}, scenario.failure
			}
			if !scenario.observed.Load() {
				t.Error("history transaction before unknown readback")
			}
			return retentionCallback(fn, retentionEmptyScope(t))
		}
		db.observeHistory = func(_ context.Context, kind, id string) error {
			if kind != "delivery" || id != d.ID {
				t.Error("uncertain history identity changed")
			}
			scenario.observed.Store(true)
			return nil
		}
	}
	scenario.r, scenario.plan = retentionWithCollectors(t, db)
	calls := []retentionCollectorOperation{retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile")}
	switch mode {
	case "config":
		calls = append(calls, retentionCollectorOperation{name: "config.pass", invoke: func(context.Context) (int, store.Completion, error) {
			scenario.unknownCalls.Add(1)
			return 0, store.Completion{}, &core.ConfigGCUnknownError{Identity: store.WebhookConfigGCCandidate{Kind: "binding", ID: "original"}, Cause: scenario.failure}
		}})
	case "receipt":
		calls = append(calls, retentionConfigResult(0, nil), retentionCollectorOperation{name: "receipt.pass", completion: store.Completion{Outcome: store.TransactionUnknown}, invoke: func(context.Context) (int, store.Completion, error) {
			scenario.unknownCalls.Add(1)
			return 0, store.Completion{Outcome: store.TransactionUnknown}, &core.ReceiptGCUnknownError{Identity: store.WebhookReceiptIdentity{OperationID: "original"}, Cause: scenario.failure}
		}})
	case "history":
		calls = append(calls, retentionConfigResult(0, nil), retentionReceiptResult(0, store.Completion{Outcome: store.TransactionCommitted}, nil), retentionOperation("history.write"))
	default:
		t.Fatalf("invalid test mode %s", mode)
	}
	scenario.plan.queue(calls...)
	return scenario
}
func (s *retentionUnknownFixture) queueReadback(cause error) {
	observe := func(context.Context) (int, store.Completion, error) {
		if cause == nil {
			s.observed.Store(true)
			return 0, store.Completion{}, nil
		}
		if s.mode == "receipt" {
			return 0, store.Completion{}, &core.ReceiptGCUnknownError{Identity: store.WebhookReceiptIdentity{OperationID: "original"}, Cause: cause}
		}
		return 0, store.Completion{}, &core.ConfigGCUnknownError{Identity: store.WebhookConfigGCCandidate{Kind: "binding", ID: "original"}, Cause: cause}
	}
	receipt, config := retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile")
	if s.mode == "receipt" {
		receipt.invoke = observe
	}
	if s.mode == "config" {
		config.invoke = observe
	}
	calls := []retentionCollectorOperation{receipt}
	if s.mode == "receipt" && cause != nil {
		s.plan.queue(calls...)
		return
	}
	if s.mode == "history" {
		calls = append(calls, retentionCollectorOperation{name: "history.observe", err: cause})
		if cause != nil {
			s.plan.queue(calls...)
			return
		}
	}
	calls = append(calls, config)
	if s.mode == "config" && cause != nil {
		s.plan.queue(calls...)
		return
	}
	calls = append(calls, retentionReceiptResult(0, store.Completion{Outcome: store.TransactionCommitted}, nil), retentionOperation("history.write"), retentionConfigResult(0, nil))
	s.plan.queue(calls...)
}

func TestRetentionReconcilesEveryUnknownBeforeMoreWrites(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			s := retentionUnknownScenario(t, mode)
			n, _, err := s.r.Pass(t.Context())
			if !errors.Is(err, s.failure) || n != 0 || !s.r.Observation().Unknown || !s.r.Observation().Failed || s.unknownCalls.Load() != 1 {
				t.Fatalf("unknown pass %d %+v supplied unknown calls%d err%v", n, s.r.Observation(), s.unknownCalls.Load(), err)
			}
			s.queueReadback(nil)
			n, _, err = s.r.Pass(t.Context())
			if err != nil || n != 0 || !s.observed.Load() || s.r.Observation().Unknown || s.unknownCalls.Load() != 1 {
				t.Fatalf("reconcile %d %+v supplied unknown calls%d err%v", n, s.r.Observation(), s.unknownCalls.Load(), err)
			}
		})
	}
}

func TestRetentionKeepsUnreadableUnknownWithoutRepeatingWrite(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			s := retentionUnknownScenario(t, mode)
			failure := errors.New("readback unavailable")
			_, _, err := s.r.Pass(t.Context())
			if err == nil {
				t.Fatal("unknown disappeared")
			}
			s.queueReadback(failure)
			_, _, err = s.r.Pass(t.Context())
			if !errors.Is(err, failure) || !s.r.Observation().Unknown || s.unknownCalls.Load() != 1 || s.observed.Load() {
				t.Fatalf("unreadable unknown %+v calls%d err%v", s.r.Observation(), s.unknownCalls.Load(), err)
			}
			s.queueReadback(nil)
			_, _, err = s.r.Pass(t.Context())
			if err != nil || s.r.Observation().Unknown || s.unknownCalls.Load() != 1 || !s.observed.Load() {
				t.Fatalf("resolved unknown %+v err%v", s.r.Observation(), err)
			}
		})
	}
}

func retentionConfigAction(fn func(context.Context) (int, error)) retentionCollectorOperation {
	return retentionCollectorOperation{name: "config.pass", invoke: func(ctx context.Context) (int, store.Completion, error) {
		n, err := fn(ctx)
		return n, store.Completion{}, err
	}}
}

func TestRetentionPassInternalBudgetDoesNotCancelItsParent(t *testing.T) {
	db := retentionEmptyStore(t)
	r, p := retentionWithCollectors(t, db)
	wait := retentionConfigAction(func(c context.Context) (int, error) { <-c.Done(); return 0, c.Err() })
	p.queue(retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile"), wait)
	parent := context.Background()
	n, more, err := r.pass(parent, 20*time.Millisecond)
	if err != nil || n != 0 || !more || parent.Err() != nil || r.Observation().Failed {
		t.Fatalf("internal budget n%d more%v parent%v obs%+v err%v", n, more, parent.Err(), r.Observation(), err)
	}
	c, cancel := context.WithCancel(context.Background())
	cancel()
	p.queue(retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile"), retentionReceiptResult(0, store.Completion{Outcome: store.TransactionCommitted}, nil), retentionOperation("history.write"), wait)
	_, _, err = r.Pass(c)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("parent cancellation lost: %v", err)
	}
}

func TestRetentionContinuesOtherClassesAfterConfigTimeout(t *testing.T) {
	db := retentionEmptyStore(t)
	r, p := retentionWithCollectors(t, db)
	p.queue(retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile"), retentionConfigAction(func(c context.Context) (int, error) { <-c.Done(); return 0, c.Err() }))
	_, more, err := r.pass(context.Background(), 20*time.Millisecond)
	if err != nil || !more {
		t.Fatalf("config budget %v %v", more, err)
	}
	d := retentionDeliveryFixture()
	writes := 0
	p.history = func(_ context.Context, f func(store.WebhookRetentionScope) error) (store.Completion, error) {
		writes++
		if writes == 1 {
			s := retentionCandidateScope(t, "payload", d)
			s.payload = func(context.Context, string, time.Time) (int, error) { return 1, nil }
			return retentionCallback(f, s)
		}
		return retentionCallback(f, retentionEmptyScope(t))
	}
	p.queue(retentionPassCalls(0, 0, "receipt", "history", "history", "config")...)
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
	r, p := retentionWithCollectors(t, db)
	p.queue(retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile"), retentionConfigAction(func(c context.Context) (int, error) {
		close(entered)
		select {
		case <-release:
			return 0, nil
		case <-c.Done():
			return 0, c.Err()
		}
	}), retentionReceiptResult(0, store.Completion{Outcome: store.TransactionCommitted}, nil), retentionOperation("history.write"))
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
	r, p = retentionWithCollectors(t, db)
	p.queue(retentionOperation("receipt.reconcile"), retentionOperation("config.reconcile"), retentionConfigAction(func(c context.Context) (int, error) {
		deadline, ok := c.Deadline()
		if !ok || deadline.Sub(started) < 1900*time.Millisecond || deadline.Sub(started) > 2100*time.Millisecond {
			t.Errorf("production budget=%v present=%v", deadline.Sub(started), ok)
		}
		return 0, nil
	}), retentionReceiptResult(0, store.Completion{Outcome: store.TransactionCommitted}, nil), retentionOperation("history.write"))
	_, _, err = r.Pass(t.Context())
	retentionFail(t, err)
}

func TestRetentionSharedAffectedRowBudgetCountsEachClass(t *testing.T) {
	db := retentionEmptyStore(t)
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
	r, p := retentionWithCollectors(t, db)
	classes := []string{"config", "receipt"}
	for i := 0; i < 250; i++ {
		classes = append(classes, "history")
	}
	p.queue(retentionPassCalls(125, 125, classes...)...)
	n, more, err := r.Pass(t.Context())
	obs := r.Observation()
	if err != nil || n != 500 || !more || history != 250 || obs.ConfigRows != 125 || obs.ReceiptRows != 125 || obs.HistoryRows != 250 || obs.ConfirmedRows != 500 {
		t.Fatalf("shared budget n%d more%v history%d obs%+v err%v", n, more, history, obs, err)
	}
}
