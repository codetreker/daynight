package webhook

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// The stub controls failure and cancellation at component boundaries. Database
// locking, commits and acknowledgement loss have separate PostgreSQL tests.
type retentionLifecycleDB struct {
	mode                       string
	entered, release, observed chan struct{}
	reconciled                 atomic.Bool
	writeCount                 atomic.Int64
	readFailure                atomic.Bool
}

func (d *retentionLifecycleDB) ScanWebhookConfigGC(ctx context.Context, _ *store.WebhookConfigGCCandidate, _ int) (store.WebhookConfigGCScan, error) {
	switch d.mode {
	case "failure":
		return store.WebhookConfigGCScan{}, errors.New("scan unavailable")
	case "block":
		close(d.entered)
		<-d.release
		return store.WebhookConfigGCScan{}, nil
	case "deadline":
		<-ctx.Done()
		return store.WebhookConfigGCScan{}, ctx.Err()
	case "config":
		if !d.reconciled.Load() {
			return store.WebhookConfigGCScan{Barrier: "1", Candidates: []store.WebhookConfigGCCandidate{{Kind: "binding", ID: "original"}}}, nil
		}
	}
	return store.WebhookConfigGCScan{}, nil
}
func (*retentionLifecycleDB) WebhookConfigGCBarrierPassed(context.Context, string) (bool, error) {
	return true, nil
}
func (d *retentionLifecycleDB) WriteWebhookConfigGC(context.Context, store.WebhookConfigGCCandidate, func(store.WebhookConfigGCScope) error) (store.Completion, error) {
	d.writeCount.Add(1)
	return store.Completion{Outcome: store.TransactionUnknown}, errors.New("configuration reply lost")
}
func (d *retentionLifecycleDB) ObserveWebhookConfigGC(context.Context, store.WebhookConfigGCCandidate) (bool, error) {
	if d.readFailure.Load() {
		return false, errors.New("configuration read unavailable")
	}
	d.reconciled.Store(true)
	if d.observed != nil {
		select {
		case d.observed <- struct{}{}:
		default:
		}
	}
	return true, nil
}
func (d *retentionLifecycleDB) ExpiredWebhookReceipts(context.Context, *store.WebhookReceiptIdentity, int) ([]store.WebhookReceiptIdentity, error) {
	if d.mode == "receipt" && !d.reconciled.Load() {
		return []store.WebhookReceiptIdentity{{OperationID: "original"}}, nil
	}
	return nil, nil
}
func (d *retentionLifecycleDB) WriteWebhookReceiptGC(context.Context, store.WebhookReceiptIdentity, func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	d.writeCount.Add(1)
	return store.Completion{Outcome: store.TransactionUnknown}, errors.New("receipt reply lost")
}
func (d *retentionLifecycleDB) ObserveWebhookReceipt(context.Context, store.WebhookReceiptIdentity) (time.Time, bool, error) {
	if d.readFailure.Load() {
		return time.Time{}, false, errors.New("receipt read unavailable")
	}
	d.reconciled.Store(true)
	if d.observed != nil {
		select {
		case d.observed <- struct{}{}:
		default:
		}
	}
	return time.Time{}, true, nil
}
func (d *retentionLifecycleDB) WriteWebhookRetention(context.Context, func(store.WebhookRetentionScope) error) (store.Completion, error) {
	if d.mode == "history" && !d.reconciled.Load() {
		d.writeCount.Add(1)
		return store.Completion{Outcome: store.TransactionUnknown}, errors.New("history reply lost")
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (d *retentionLifecycleDB) ObserveWebhookRetention(context.Context, string, string) error {
	if d.readFailure.Load() {
		return errors.New("history read unavailable")
	}
	d.reconciled.Store(true)
	if d.observed != nil {
		select {
		case d.observed <- struct{}{}:
		default:
		}
	}
	return nil
}

func TestRetentionBackgroundFailuresAndStop(t *testing.T) {
	causeDB := &retentionLifecycleDB{mode: "failure"}
	r := NewRetention(causeDB)
	if err := r.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-r.Failures():
		if err == nil || err.Error() != "scan unavailable" {
			t.Fatalf("unexpected failure: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("permanent failure was not reported")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := r.Stop(ctx); err != nil {
		t.Fatal(err)
	}

	blocked := &retentionLifecycleDB{mode: "block", entered: make(chan struct{}), release: make(chan struct{})}
	r = NewRetention(blocked)
	if err := r.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-blocked.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("blocked store was not entered")
	}
	timeout, stop := context.WithTimeout(context.Background(), 30*time.Millisecond)
	if err := r.Stop(timeout); !errors.Is(err, context.DeadlineExceeded) {
		stop()
		close(blocked.release)
		t.Fatalf("stop should report timeout: %v", err)
	}
	stop()
	close(blocked.release)
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := r.Stop(ctx2); err != nil {
		t.Fatalf("stop after store released: %v", err)
	}
}

func TestRetentionBackgroundReconcilesUnknownBeforeMoreWrites(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			db := &retentionLifecycleDB{mode: mode, observed: make(chan struct{}, 1)}
			r := NewRetention(db)
			r.retryInterval = 20 * time.Millisecond
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := r.Start(ctx); err != nil {
				t.Fatal(err)
			}
			defer func() {
				stop, c := context.WithTimeout(context.Background(), time.Second)
				defer c()
				if err := r.Stop(stop); err != nil {
					t.Error(err)
				}
			}()
			select {
			case <-db.observed:
			case err := <-r.Failures():
				t.Fatalf("unknown stopped the worker: %v", err)
			case <-ctx.Done():
				t.Fatal("unknown was not reconciled")
			}
			if db.writeCount.Load() != 1 {
				t.Fatalf("replayed uncertain write %d times", db.writeCount.Load())
			}
		})
	}
}

func TestRetentionPassPreservesUnreadableUnknown(t *testing.T) {
	for _, mode := range []string{"config", "receipt", "history"} {
		t.Run(mode, func(t *testing.T) {
			db := &retentionLifecycleDB{mode: mode}
			db.readFailure.Store(true)
			r := NewRetention(db)
			if _, _, err := r.Pass(context.Background()); err == nil || !r.Observation().Unknown {
				t.Fatalf("missing uncertain write: %v", err)
			}
			if _, _, err := r.Pass(context.Background()); err == nil || !r.Observation().Unknown || db.writeCount.Load() != 1 {
				t.Fatalf("unreadable result was lost or replayed: %v", err)
			}
			db.readFailure.Store(false)
			if _, _, err := r.Pass(context.Background()); err != nil || r.Observation().Unknown || db.writeCount.Load() != 1 {
				t.Fatalf("readback did not resume safely: %v", err)
			}
		})
	}
}

func TestRetentionPassConcurrentAndBounded(t *testing.T) {
	if _, _, err := NewRetention(nil).Pass(context.Background()); err == nil {
		t.Fatal("missing store accepted")
	}
	db := &retentionLifecycleDB{mode: "block", entered: make(chan struct{}), release: make(chan struct{})}
	r := NewRetention(db)
	finished := make(chan error, 1)
	go func() { _, _, err := r.Pass(context.Background()); finished <- err }()
	select {
	case <-db.entered:
	case <-time.After(time.Second):
		t.Fatal("first pass not entered")
	}
	if n, more, err := r.Pass(context.Background()); err != nil || n != 0 || !more {
		t.Fatalf("concurrent pass: %d %v %v", n, more, err)
	}
	close(db.release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	db = &retentionLifecycleDB{mode: "deadline"}
	r = NewRetention(db)
	started := time.Now()
	n, more, err := r.Pass(context.Background())
	if err != nil || n != 0 || !more || time.Since(started) > 3*time.Second {
		t.Fatalf("bounded scan: %d %v %v", n, more, err)
	}
}

var _ retentionStore = (*retentionLifecycleDB)(nil)
